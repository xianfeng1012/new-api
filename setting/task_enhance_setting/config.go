// Package task_enhance_setting holds the local switch and price table for the
// "generate then enhance" video chain (Volcengine AI MediaKit).
//
// The whole feature is off by default. When Enabled is true, a finished video
// task whose model matches Rules (and is not in ExcludeModels) is followed by a
// MediaKit enhance-video job; the extra fee is billed to the same user/token
// that submitted the video, with the configured markup (default +15%).
//
// Price formula (official AI MediaKit 视频工具计费):
//
//	费用 = 输出时长(分钟) × 计费换算系数 × 基准单价(元/分钟)
//	本地额度 = 费用 × Markup ÷ USDExchangeRate × QuotaPerUnit
//
// The coefficient is chosen by the OUTPUT resolution tier and frame rate that
// MediaKit reports in result.resolution / result.fps, so the local charge
// follows the actual output instead of the requested parameters.
package task_enhance_setting

import (
	"math"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/setting/config"
	"github.com/QuantumNous/new-api/setting/operation_setting"
)

// FpsMultiplier maps an output frame rate to the billing multiplier.
type FpsMultiplier struct {
	MaxFPS     float64 `json:"max_fps"`
	Multiplier float64 `json:"multiplier"`
}

// ModelRule is one "which models, which enhance options" entry. The first rule
// whose Models contains the task's model (or "*") wins.
type ModelRule struct {
	Models      []string `json:"models"`
	ToolVersion string   `json:"tool_version"` // "" / "standard" / "professional" / "fast" / "generative"
	Resolution  string   `json:"resolution"`   // "auto" keeps MediaKit's default; else 720p/1080p/2k/4k
	FPS         int      `json:"fps"`          // 0 keeps the source frame rate
	Scene       string   `json:"scene"`        // e.g. "aigc" for AI-generated sources
}

type TaskEnhanceSetting struct {
	Enabled       bool        `json:"enabled"`
	ExcludeModels []string    `json:"exclude_models"`
	Rules         []ModelRule `json:"rules"`

	// MediaKit credentials. ChannelID wins when set: the channel's key/base_url
	// are then the single source of truth and can be rotated from the panel.
	BaseURL   string `json:"base_url"`
	ApiKey    string `json:"api_key"`
	ChannelID int    `json:"channel_id"`

	// Output storage. Empty OutputBucket keeps MediaKit's 24h temporary link.
	//   tos://<OutputBucket> is sent as media_output_destination.
	//   PublicBaseURL  -> client download URL = PublicBaseURL + "/" + objectKey (public-read bucket)
	//   TosAccessKey/TosSecretKey/TosRegion -> presigned URL
	OutputBucket      string `json:"output_bucket"`
	PublicBaseURL     string `json:"public_base_url"`
	TosAccessKey      string `json:"tos_access_key"`
	TosSecretKey      string `json:"tos_secret_key"`
	TosRegion         string `json:"tos_region"`
	PresignTTLSeconds int    `json:"presign_ttl_seconds"`

	// Billing. Values are 元/分钟 (official list price by default).
	BasePricePerMinute     map[string]float64            `json:"base_price_per_minute"`
	ResolutionCoefficients map[string]map[string]float64 `json:"resolution_coefficients"`
	FpsMultipliers         []FpsMultiplier               `json:"fps_multipliers"`
	Markup                 float64                       `json:"markup"`

	TimeoutMinutes int    `json:"timeout_minutes"`
	MaxRetries     int    `json:"max_retries"`
	OnFailure      string `json:"on_failure"` // "deliver_original"
}

var taskEnhanceSetting = TaskEnhanceSetting{
	Enabled:       false,
	ExcludeModels: []string{},
	Rules: []ModelRule{
		{Models: []string{"*"}, ToolVersion: "standard", Resolution: "auto", FPS: 0, Scene: "aigc"},
	},
	BaseURL: "https://mediakit.cn-beijing.volces.com",
	// AI MediaKit 视频工具计费：标准版/专业版同接口不同 tool_version 与系数。
	BasePricePerMinute: map[string]float64{
		"standard":     0.75,
		"professional": 0.75,
		"fast":         0.2,
		"generative":   2.5,
	},
	// 官方示例：标准版 1080P/≤30fps 系数 2、专业版 1080P/≤30fps 系数 20、
	// 大模型版 720P=1/1080P=2/2K=4/4K=8。其余档位按同一结构外推，账单不符时改这里即可。
	ResolutionCoefficients: map[string]map[string]float64{
		"standard":     {"480p": 1, "720p": 1, "1080p": 2, "2k": 4, "4k": 8},
		"professional": {"480p": 10, "720p": 10, "1080p": 20, "2k": 40, "4k": 80},
		"fast":         {"480p": 1, "720p": 1, "1080p": 2, "2k": 4, "4k": 8},
		"generative":   {"480p": 1, "720p": 1, "1080p": 2, "2k": 4, "4k": 8},
	},
	FpsMultipliers: []FpsMultiplier{
		{MaxFPS: 30, Multiplier: 1},
		{MaxFPS: 60, Multiplier: 2},
		{MaxFPS: 120, Multiplier: 4},
	},
	Markup:            1.15,
	PresignTTLSeconds: 604800,
	TimeoutMinutes:    30,
	MaxRetries:        2,
	OnFailure:         "deliver_original",
}

func init() {
	config.GlobalConfig.Register("task_enhance_setting", &taskEnhanceSetting)
}

func GetCopy() TaskEnhanceSetting {
	clone := taskEnhanceSetting
	clone.ExcludeModels = append([]string(nil), taskEnhanceSetting.ExcludeModels...)
	clone.Rules = append([]ModelRule(nil), taskEnhanceSetting.Rules...)
	clone.BasePricePerMinute = map[string]float64{}
	for key, value := range taskEnhanceSetting.BasePricePerMinute {
		clone.BasePricePerMinute[key] = value
	}
	clone.ResolutionCoefficients = map[string]map[string]float64{}
	for version, table := range taskEnhanceSetting.ResolutionCoefficients {
		inner := map[string]float64{}
		for tier, coefficient := range table {
			inner[tier] = coefficient
		}
		clone.ResolutionCoefficients[version] = inner
	}
	clone.FpsMultipliers = append([]FpsMultiplier(nil), taskEnhanceSetting.FpsMultipliers...)
	return clone
}

// MatchRule resolves the enhance options for a model name.
func MatchRule(model string) (ModelRule, bool) {
	model = strings.TrimSpace(model)
	if model == "" {
		return ModelRule{}, false
	}
	for _, excluded := range taskEnhanceSetting.ExcludeModels {
		if strings.EqualFold(strings.TrimSpace(excluded), model) {
			return ModelRule{}, false
		}
	}
	for _, rule := range taskEnhanceSetting.Rules {
		for _, declared := range rule.Models {
			if declared == "*" || strings.EqualFold(strings.TrimSpace(declared), model) {
				return rule, true
			}
		}
	}
	return ModelRule{}, false
}

func IsEnabled() bool { return taskEnhanceSetting.Enabled }

// SupportedToolVersions is the set MediaKit's enhance-video endpoint accepts.
// "fast" and "generative" appear in other Volcengine video-tool docs but this
// endpoint rejects them with an enum validation error, which would make every
// single enhance job fail and leave customers with the original video only.
var SupportedToolVersions = map[string]bool{
	"standard":     true,
	"professional": true,
}

// ToolVersion normalizes a rule value to a tier MediaKit accepts, defaulting to
// standard so a bad setting degrades instead of breaking the whole chain.
func ToolVersion(rule ModelRule) string {
	version := strings.ToLower(strings.TrimSpace(rule.ToolVersion))
	if version == "" || !SupportedToolVersions[version] {
		return "standard"
	}
	return version
}

// ToolVersionSupported reports whether a configured tool version is accepted
// upstream; callers use it to warn about a rule that will be downgraded.
func ToolVersionSupported(raw string) bool {
	version := strings.ToLower(strings.TrimSpace(raw))
	return version == "" || SupportedToolVersions[version]
}

// NormalizeResolutionTier maps an output resolution string to a price tier.
func NormalizeResolutionTier(resolution string) string {
	value := strings.ToLower(strings.TrimSpace(resolution))
	value = strings.ReplaceAll(value, " ", "")
	switch value {
	case "480p", "540p", "sd":
		return "480p"
	case "720p", "hd":
		return "720p"
	case "1080p", "fhd", "1080i":
		return "1080p"
	case "2k", "1440p", "qhd":
		return "2k"
	case "4k", "2160p", "uhd":
		return "4k"
	}
	// 认不出的档位按 1080P 计（宁可多算一档，也不漏收）。
	return "1080p"
}

func PricePerMinute(toolVersion string) float64 {
	if price, ok := taskEnhanceSetting.BasePricePerMinute[toolVersion]; ok && price > 0 {
		return price
	}
	return 0
}

func Coefficient(toolVersion, resolution string, fps float64) float64 {
	table, ok := taskEnhanceSetting.ResolutionCoefficients[toolVersion]
	if !ok || len(table) == 0 {
		return 0
	}
	coefficient, ok := table[NormalizeResolutionTier(resolution)]
	if !ok || coefficient <= 0 {
		return 0
	}
	return coefficient * fpsMultiplier(fps)
}

func fpsMultiplier(fps float64) float64 {
	if fps <= 0 {
		return 1
	}
	multiplier := 0.0
	for _, entry := range taskEnhanceSetting.FpsMultipliers {
		if entry.MaxFPS <= 0 || entry.Multiplier <= 0 {
			continue
		}
		if fps <= entry.MaxFPS {
			return entry.Multiplier
		}
		multiplier = entry.Multiplier
	}
	if multiplier > 0 {
		return multiplier
	}
	return 1
}

// CostCNY returns the raw upstream cost in 元 for one finished enhance job.
func CostCNY(toolVersion, resolution string, fps, seconds float64) float64 {
	price := PricePerMinute(toolVersion)
	coefficient := Coefficient(toolVersion, resolution, fps)
	if price <= 0 || coefficient <= 0 || seconds <= 0 {
		return 0
	}
	return seconds / 60 * coefficient * price
}

// QuotaForUsage converts one finished enhance job into local quota with markup.
func QuotaForUsage(toolVersion, resolution string, fps, seconds float64) int {
	cost := CostCNY(toolVersion, resolution, fps, seconds)
	if cost <= 0 {
		return 0
	}
	rate := operation_setting.USDExchangeRate
	if rate <= 0 {
		rate = 7.3
	}
	markup := taskEnhanceSetting.Markup
	if markup <= 0 {
		markup = 1
	}
	quotaFloat := cost * markup / rate * float64(common.QuotaPerUnit)
	if math.IsNaN(quotaFloat) || math.IsInf(quotaFloat, 0) || quotaFloat < 0 {
		return 0
	}
	quota, _ := common.QuotaFromFloatChecked(quotaFloat)
	if quota < 1 {
		return 1
	}
	return quota
}
