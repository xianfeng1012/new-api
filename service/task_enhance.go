package service

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/logger"
	"github.com/QuantumNous/new-api/model"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/setting/task_enhance_setting"
)

// EnhanceChildPlatform is the task platform of the MediaKit post-processing
// child task. It must equal the JS task plugin key so the shared polling loop
// resolves the adaptor for these rows.
const EnhanceChildPlatform = constant.TaskPlatform("mediakit")

// EnhanceSourceArtifactKey is a capability-only artifact key used by the
// enhance chain to download the source video. It resolves to the same "video"
// artifact but is exempt from the "enhance pending" gate, because the enhance
// job must fetch the source while the parent task is still pending.
const EnhanceSourceArtifactKey = "video-source"

// EnhanceChildModel is the model name written on child rows. It is an internal
// name: children are hidden from customer task lists and only administrators
// see them next to the original video task.
const EnhanceChildModel = "mediakit-video-enhance"

// EnhanceChildAction labels the child task in logs and the admin task list.
const EnhanceChildAction = "video_enhance"

// IsEnhanceChild reports whether a task row is a post-processing child.
func IsEnhanceChild(task *model.Task) bool {
	return task != nil && task.Platform == EnhanceChildPlatform && task.PrivateData.EnhanceParentTaskID != ""
}

// MaybeSubmitEnhance starts the post-processing job for a task that just
// finished successfully. It is called from the polling loop after the parent
// task has been settled; every failure path keeps the original video intact.
func MaybeSubmitEnhance(ctx context.Context, parent *model.Task) {
	if parent == nil || ctx == nil {
		return
	}
	if !task_enhance_setting.IsEnabled() {
		return
	}
	if parent.Status != model.TaskStatusSuccess {
		return
	}
	// 只处理视频任务；子任务自己不再触发（避免链式放大）。
	if parent.Platform == EnhanceChildPlatform || parent.Platform == constant.TaskPlatformMidjourney || parent.Platform == constant.TaskPlatformSuno {
		return
	}
	if parent.PrivateData.EnhanceSubmittedAt > 0 {
		return
	}
	modelName := strings.TrimSpace(parent.Properties.OriginModelName)
	if modelName == "" {
		modelName = strings.TrimSpace(parent.Properties.UpstreamModelName)
	}
	rule, ok := task_enhance_setting.MatchRule(modelName)
	if !ok {
		return
	}
	if !task_enhance_setting.ToolVersionSupported(rule.ToolVersion) {
		logger.LogWarn(ctx, fmt.Sprintf(
			"视频超分：档位 %q 不被 MediaKit 支持（仅 standard/professional），本次按 standard 提交；请在「视频超分」设置页改掉",
			strings.TrimSpace(rule.ToolVersion)))
	}
	baseURL, apiKey, ok := enhanceCredentials()
	if !ok {
		logger.LogWarn(ctx, "视频超分：未配置 MediaKit 凭据（设置 → 视频超分 的 ChannelID 或 ApiKey），跳过")
		return
	}
	// 子任务轮询要按渠道取 key/base_url（updateVideoSingleTask 用 task.ChannelId），
	// 因此必须配一个只放 MediaKit 凭据的渠道行，否则子任务会拿父任务的视频渠道凭据去查。
	enhanceChannelID := task_enhance_setting.GetCopy().ChannelID
	if enhanceChannelID <= 0 {
		logger.LogWarn(ctx, "视频超分：未配置 ChannelID（子任务轮询需要渠道凭据），跳过")
		return
	}
	inputURL, err := BuildTaskArtifactContentURL(parent.TaskID, EnhanceSourceArtifactKey)
	if err != nil {
		logger.LogWarn(ctx, fmt.Sprintf("视频超分：生成原片公开地址失败 task=%s: %v", parent.TaskID, err))
		return
	}

	// 先落「已提交」标记，避免轮询重复触发（进程在提交中途退出时宁可漏一次，也不重复计费）。
	if err := markEnhanceSubmitted(parent, ""); err != nil {
		logger.LogWarn(ctx, fmt.Sprintf("视频超分：写入标记失败 task=%s: %v", parent.TaskID, err))
		return
	}

	body := buildEnhanceRequestBody(rule, inputURL)
	upstreamTaskID, taskData, err := submitEnhanceJob(ctx, baseURL, apiKey, body)
	if err != nil {
		logger.LogWarn(ctx, fmt.Sprintf("视频超分：提交失败 task=%s: %v（保留原片）", parent.TaskID, err))
		return
	}
	child, err := createEnhanceChild(parent, rule, enhanceChannelID, upstreamTaskID, taskData)
	if err != nil {
		logger.LogWarn(ctx, fmt.Sprintf("视频超分：落子任务失败 task=%s upstream=%s: %v", parent.TaskID, upstreamTaskID, err))
		return
	}
	if err := markEnhanceSubmitted(parent, child.TaskID); err != nil {
		logger.LogWarn(ctx, fmt.Sprintf("视频超分：回写子任务号失败 task=%s: %v", parent.TaskID, err))
	}
	logger.LogInfo(ctx, fmt.Sprintf("视频超分：已提交 task=%s model=%s tool=%s upstream=%s child=%s",
		parent.TaskID, modelName, task_enhance_setting.ToolVersion(rule), upstreamTaskID, child.TaskID))
}

// SettleEnhanceChild finalizes one post-processing child task. A successful job
// charges the enhance fee to the same user/token that paid for the video and
// hands the enhanced file to the customer; a failed job keeps the original
// video as the customer-visible artifact and charges nothing extra.
func SettleEnhanceChild(ctx context.Context, child *model.Task, result *relaycommon.TaskInfo) bool {
	if child == nil {
		return false
	}
	parentID := parseEnhanceParentID(child.PrivateData.EnhanceParentTaskID)
	if child.Status != model.TaskStatusSuccess {
		logger.LogInfo(ctx, fmt.Sprintf("视频超分：子任务未成功 child=%s status=%s reason=%s（原片照常交付，不额外计费）",
			child.TaskID, child.Status, child.FailReason))
		// 子任务失败：解除父任务的「超分中」等待，客户拿原片（管理员仍能对照原片/子任务）。
		if parentID > 0 {
			releaseEnhancePending(ctx, parentID, "子任务未成功")
		}
		return true
	}
	body := map[string]any{}
	if len(child.Data) > 0 {
		_ = common.Unmarshal(child.Data, &body)
	}
	enhancedURL := enhanceResultURL(body)
	if enhancedURL == "" && result != nil {
		enhancedURL = strings.TrimSpace(result.Url)
	}
	if enhancedURL == "" {
		logger.LogWarn(ctx, fmt.Sprintf("视频超分：子任务成功但取不到成片地址 child=%s（保留原片）", child.TaskID))
		if parentID > 0 {
			releaseEnhancePending(ctx, parentID, "子任务无成片地址")
		}
		return true
	}
	resolved := resolveEnhanceOutputURL(enhancedURL)
	seconds := enhanceResultSeconds(body)
	if seconds <= 0 && result != nil {
		seconds = relaycommon.TaskUsageDurationSeconds(result.UsageFacts)
	}
	toolVersion := strings.TrimSpace(toString(body, "result", "tool_version"))
	if toolVersion == "" {
		toolVersion = task_enhance_setting.ToolVersion(task_enhance_setting.ModelRule{})
	}
	resolution := strings.TrimSpace(toString(body, "result", "resolution"))
	fps := toFloat(body, "result", "fps")
	quota := task_enhance_setting.QuotaForUsage(toolVersion, resolution, fps, seconds)
	if quota > 0 {
		RecalculateTaskQuota(ctx, child, quota, fmt.Sprintf("视频超分结算（%s，%s，%.0ffps，%.1fs，含 %.0f%% 服务费）",
			toolVersion, resolution, fps, seconds, (task_enhance_setting.GetCopy().Markup-1)*100))
	}
	if resolved != enhancedURL {
		if err := model.UpdateTaskResultURL(child, resolved); err != nil {
			logger.LogWarn(ctx, fmt.Sprintf("视频超分：回写成片地址失败 child=%s: %v", child.TaskID, err))
		} else {
			child.PrivateData.ResultURL = resolved
		}
	}
	if parentID > 0 {
		publishEnhancedArtifact(ctx, parentID, resolved, child.TaskID)
	}
	return true
}

// publishEnhancedArtifact swaps the customer-visible artifact of the original
// video task to the enhanced file while keeping the original address available
// to administrators (PrivateData.OriginResultURL).
func publishEnhancedArtifact(ctx context.Context, parentID int64, enhancedURL, childTaskID string) {
	parent, err := model.GetTaskByID(parentID)
	if err != nil || parent == nil {
		logger.LogWarn(ctx, fmt.Sprintf("视频超分：找不到父任务 id=%d: %v", parentID, err))
		return
	}
	if parent.PrivateData.OriginResultURL == "" {
		parent.PrivateData.OriginResultURL = parent.PrivateData.ResultURL
	}
	parent.PrivateData.ResultURL = enhancedURL
	parent.PrivateData.EnhanceChildTaskID = childTaskID
	parent.PrivateData.EnhancePublishedAt = time.Now().Unix()
	data := map[string]any{}
	if len(parent.Data) > 0 {
		_ = common.Unmarshal(parent.Data, &data)
	}
	if data == nil {
		data = map[string]any{}
	}
	// 插件取成片直链时按 video.url → video.video_url → url → … 顺序扫描，
	// 这里把增强结果写在最前面的位置；原始直链仍留在原字段里供管理员查看。
	video, _ := data["video"].(map[string]any)
	if video == nil {
		video = map[string]any{}
	}
	video["url"] = enhancedURL
	data["video"] = video
	// 原片地址从客户可见的数据里抹掉（只留管理员侧的 PrivateData.OriginResultURL），
	// 否则画布/客户后台拿到的 JSON 里还能看到超分前的链接。
	scrubDataURL(data, parent.PrivateData.OriginResultURL)
	rawData, err := common.Marshal(data)
	if err != nil {
		logger.LogWarn(ctx, fmt.Sprintf("视频超分：重写父任务数据失败 task=%s: %v", parent.TaskID, err))
		return
	}
	if err := model.UpdateTaskDataAndPrivateData(parent.ID, rawData, &parent.PrivateData); err != nil {
		logger.LogWarn(ctx, fmt.Sprintf("视频超分：保存父任务产物失败 task=%s: %v", parent.TaskID, err))
		return
	}
	logger.LogInfo(ctx, fmt.Sprintf("视频超分：父任务产物已指向超分片 task=%s child=%s", parent.TaskID, childTaskID))
}

func enhanceCredentials() (string, string, bool) {
	setting := task_enhance_setting.GetCopy()
	baseURL := strings.TrimSpace(setting.BaseURL)
	apiKey := strings.TrimSpace(setting.ApiKey)
	if setting.ChannelID > 0 {
		if channel, err := model.CacheGetChannel(setting.ChannelID); err == nil && channel != nil {
			if trimmed := strings.TrimSpace(channel.GetBaseURL()); trimmed != "" {
				baseURL = trimmed
			}
			if trimmed := strings.TrimSpace(channel.Key); trimmed != "" {
				apiKey = trimmed
			}
		}
	}
	if baseURL == "" {
		baseURL = "https://mediakit.cn-beijing.volces.com"
	}
	if apiKey == "" {
		return "", "", false
	}
	return strings.TrimRight(baseURL, "/"), apiKey, true
}

func buildEnhanceRequestBody(rule task_enhance_setting.ModelRule, inputURL string) map[string]any {
	setting := task_enhance_setting.GetCopy()
	body := map[string]any{"video_url": inputURL}
	if version := strings.TrimSpace(rule.ToolVersion); version != "" {
		body["tool_version"] = version
	}
	if resolution := strings.TrimSpace(rule.Resolution); resolution != "" && !strings.EqualFold(resolution, "auto") {
		body["resolution"] = resolution
	}
	if rule.FPS > 0 {
		body["fps"] = rule.FPS
	}
	if scene := strings.TrimSpace(rule.Scene); scene != "" {
		body["scene"] = scene
	}
	if bucket := strings.TrimSpace(setting.OutputBucket); bucket != "" {
		body["media_output_destination"] = "tos://" + strings.TrimPrefix(bucket, "tos://")
	}
	return body
}

func submitEnhanceJob(ctx context.Context, baseURL, apiKey string, body map[string]any) (string, json.RawMessage, error) {
	payload, err := common.Marshal(body)
	if err != nil {
		return "", nil, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+"/api/v1/tools/enhance-video", bytes.NewReader(payload))
	if err != nil {
		return "", nil, err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+apiKey)
	client := GetHttpClient()
	resp, err := client.Do(request)
	if err != nil {
		return "", nil, err
	}
	defer resp.Body.Close()
	responseBody, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return "", nil, err
	}
	parsed := map[string]any{}
	if err := common.Unmarshal(responseBody, &parsed); err != nil {
		return "", nil, fmt.Errorf("invalid enhance response: %s", string(responseBody))
	}
	if success, ok := parsed["success"].(bool); ok && !success {
		return "", nil, fmt.Errorf("enhance rejected: %s", toString(parsed, "error", "message"))
	}
	taskID := strings.TrimSpace(toString(parsed, "task_id"))
	if taskID == "" {
		return "", nil, fmt.Errorf("enhance response has no task_id: %s", string(responseBody))
	}
	return taskID, json.RawMessage(responseBody), nil
}

// createEnhanceChild inserts the hidden child task that the shared polling loop
// then drives with the mediakit plugin.
func createEnhanceChild(parent *model.Task, rule task_enhance_setting.ModelRule, enhanceChannelID int, upstreamTaskID string, taskData json.RawMessage) (*model.Task, error) {
	now := time.Now().Unix()
	child := &model.Task{
		CreatedAt:  now,
		UpdatedAt:  now,
		TaskID:     model.GenerateTaskID(),
		Platform:   EnhanceChildPlatform,
		UserId:     parent.UserId,
		Group:      parent.Group,
		ChannelId:  enhanceChannelID,
		Quota:      0, // 成功才收费：RecalculateTaskQuota 按实际输出补扣
		Action:     EnhanceChildAction,
		Status:     model.TaskStatusNotStart,
		Progress:   "0%",
		SubmitTime: now,
		Data:       taskData,
		Properties: model.Properties{
			OriginModelName:   EnhanceChildModel,
			UpstreamModelName: EnhanceChildModel,
			DurationSeconds:   parent.DurationSeconds(),
		},
		PrivateData: model.TaskPrivateData{
			UpstreamTaskID: upstreamTaskID,
			BillingSource:  parent.PrivateData.BillingSource,
			SubscriptionId: parent.PrivateData.SubscriptionId,
			TokenId:        parent.PrivateData.TokenId,
			NodeName:       parent.PrivateData.NodeName,
			BillingContext: parent.PrivateData.BillingContext,
			// 存父任务的数据库行号（回写产物时按它定位；公开任务号无法直接转成行号）
			EnhanceParentTaskID: strconv.FormatInt(parent.ID, 10),
			EnhanceToolVersion:  task_enhance_setting.ToolVersion(rule),
			EnhanceSubmittedAt:  now,
			// 没有 execution 的任务会被判定为"无插件执行"，制品投影直接返回空，
			// 管理员在任务日志里点开子任务就看不到超分片。补一个凭据无关的快照，
			// 让 mediakit 插件负责列出/取流该子任务的成片。
			Execution: &model.TaskExecutionSnapshot{
				RequestPath: "internal://task-enhance",
				TaskPlugin: &model.TaskPluginSnapshot{
					Key:        string(EnhanceChildPlatform),
					Name:       "Volcengine AI MediaKit",
					Version:    "1.0.0",
					APIVersion: 1,
				},
			},
		},
	}
	if err := child.Insert(); err != nil {
		return nil, err
	}
	return child, nil
}

func markEnhanceSubmitted(parent *model.Task, childTaskID string) error {
	// 原片地址在提交超分时就固定下来：管理员在超分进行中的窗口内也能看到超分前的原片，
	// 客户端只会拿到 ResultURL（发布后指向超分片，进行中则被「处理中」门禁挡住）。
	if parent.PrivateData.OriginResultURL == "" {
		parent.PrivateData.OriginResultURL = parent.PrivateData.ResultURL
	}
	parent.PrivateData.EnhanceSubmittedAt = time.Now().Unix()
	if childTaskID != "" {
		parent.PrivateData.EnhanceChildTaskID = childTaskID
	}
	return model.UpdateTaskPrivateData(parent.ID, &parent.PrivateData)
}

// resolveEnhanceOutputURL turns MediaKit's output address into something a
// customer can download: passthrough for http(s), public-read mapping or a
// presigned URL for tos:// results.
func resolveEnhanceOutputURL(raw string) string {
	value := strings.TrimSpace(raw)
	if value == "" {
		return ""
	}
	if strings.HasPrefix(strings.ToLower(value), "http://") || strings.HasPrefix(strings.ToLower(value), "https://") {
		return value
	}
	if !strings.HasPrefix(strings.ToLower(value), "tos://") {
		return value
	}
	rest := value[len("tos://"):]
	bucket, key, found := strings.Cut(rest, "/")
	if !found || bucket == "" || key == "" {
		return value
	}
	setting := task_enhance_setting.GetCopy()
	if base := strings.TrimSpace(setting.PublicBaseURL); base != "" {
		return strings.TrimRight(base, "/") + "/" + key
	}
	// 桶没有配公网前缀时，AK/SK 预签名留到下一轮（未验证的签名器不上线）：
	// 这里原样返回 tos://，由日志提示管理员补 PublicBaseURL。
	return value
}

func enhanceResultURL(body map[string]any) string {
	value := strings.TrimSpace(toString(body, "result", "video_url"))
	if value == "" {
		value = strings.TrimSpace(toString(body, "result", "video_urls"))
	}
	return value
}

func enhanceResultSeconds(body map[string]any) float64 {
	if value := toFloat(body, "result", "duration"); value > 0 {
		return value
	}
	return 0
}

func parseEnhanceParentID(value string) int64 {
	value = strings.TrimSpace(value)
	if value == "" {
		return 0
	}
	if id, err := strconv.ParseInt(value, 10, 64); err == nil && id > 0 {
		return id
	}
	// 兼容早期写入的公开任务号形式。
	if task, exists, err := model.GetUniqueByOnlyTaskId(value); err == nil && exists && task != nil {
		return task.ID
	}
	return 0
}

func toString(body map[string]any, path ...string) string {
	node := body
	for index, key := range path {
		if index == len(path)-1 {
			if value, ok := node[key]; ok {
				switch typed := value.(type) {
				case string:
					return typed
				default:
					return fmt.Sprintf("%v", typed)
				}
			}
			return ""
		}
		next, ok := node[key].(map[string]any)
		if !ok {
			return ""
		}
		node = next
	}
	return ""
}

func toFloat(body map[string]any, path ...string) float64 {
	node := body
	for index, key := range path {
		if index == len(path)-1 {
			switch typed := node[key].(type) {
			case float64:
				return typed
			case int:
				return float64(typed)
			case json.Number:
				value, err := typed.Float64()
				if err == nil {
					return value
				}
			case string:
				value, err := strconv.ParseFloat(strings.TrimSpace(typed), 64)
				if err == nil {
					return value
				}
			}
			return 0
		}
		next, ok := node[key].(map[string]any)
		if !ok {
			return 0
		}
		node = next
	}
	return 0
}

// releaseEnhancePending clears the customer-visible "still processing" state of a
// parent task without an enhanced artifact, so the original video is delivered
// instead of the customer waiting for a child that will never produce one.
func releaseEnhancePending(ctx context.Context, parentID int64, reason string) {
	parent, err := model.GetTaskByID(parentID)
	if err != nil || parent == nil {
		logger.LogWarn(ctx, fmt.Sprintf("视频超分：解除等待时找不到父任务 id=%d: %v", parentID, err))
		return
	}
	if parent.PrivateData.EnhancePublishedAt > 0 {
		return
	}
	parent.PrivateData.EnhancePublishedAt = time.Now().Unix()
	if err := model.UpdateTaskPrivateData(parent.ID, &parent.PrivateData); err != nil {
		logger.LogWarn(ctx, fmt.Sprintf("视频超分：解除等待失败 task=%s: %v", parent.TaskID, err))
		return
	}
	logger.LogInfo(ctx, fmt.Sprintf("视频超分：父任务解除等待（%s），客户侧回落原片 task=%s", reason, parent.TaskID))
}

// scrubDataURL removes one exact URL (the pre-enhance original) from every
// string leaf of the task data. Only exact matches are dropped, so unrelated
// links such as the enhanced result or upstream metadata stay intact.
func scrubDataURL(value any, target string) any {
	target = strings.TrimSpace(target)
	if target == "" {
		return value
	}
	switch typed := value.(type) {
	case map[string]any:
		for key, item := range typed {
			if text, ok := item.(string); ok && strings.TrimSpace(text) == target {
				delete(typed, key)
				continue
			}
			typed[key] = scrubDataURL(item, target)
		}
		return typed
	case []any:
		for index, item := range typed {
			typed[index] = scrubDataURL(item, target)
		}
		return typed
	default:
		return value
	}
}
