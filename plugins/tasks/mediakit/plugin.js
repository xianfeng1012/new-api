// 火山引擎 AI MediaKit（智能处理）任务插件。
//
// 主要用途：作为「生成后自动超分」链路里的子任务适配器 —— 中转在父任务成功后
// 用 Go 侧提交 enhance-video，拿到 amk-tool-* 任务号并落一条 platform=mediakit
// 的子任务；之后所有轮询/产物/用量都走本插件：
//   POST {baseUrl}/api/v1/tools/enhance-video   ← 提交（也支持手工两步调用）
//   GET  {baseUrl}/api/v1/tasks/{task_id}       ← 轮询，result 里带 video_url/duration/fps/resolution
//
// 计费口径：MediaKit 按「输出时长(分钟) × 系数 × 基准单价」收费，本插件把
// result.duration 作为 seconds 事实交给任务表达式结算（单价/系数在中转侧配置）。
export const meta = {
  apiVersion: 1,
  key: "mediakit",
  name: "Volcengine AI MediaKit",
  icon: "Volcengine.Color",
  description: {
    en: "Volcengine AI MediaKit video post-processing (enhance / upscale)",
    zh: "火山引擎 AI MediaKit 视频后处理（画质增强/超分）",
  },
  version: "1.0.0",
  // 不声明 channelTypes：本插件只服务中转自己创建的超分子任务（platform=mediakit，
  // 平台号即本 key），声明渠道类型会和 sora 插件抢 1 号类型导致注册冲突。
  author: { name: "local" },
  models: ["mediakit-video-enhance"],
  fetchMode: "per_task",
  usageSchema: {
    // 输出视频时长（秒）：MediaKit 返回 result.duration
    seconds: {
      type: "number",
      unit: "second",
      description: { en: "Output video duration", zh: "输出视频时长" },
    },
  },
  usageExamples: [{ label: "8s", facts: { seconds: 8 } }],
  // meta 里声明协议归属，导出的 protocols 提供实现（两者缺一不可）。
  protocols: [{ name: "openai_responses", supports: ["stream", "sync", "background"] }],
};

function trimmed(value) {
  return String(value || "").trim();
}

function isOK(body) {
  return !body || body.success !== false;
}

function resultNode(data) {
  const node = data && typeof data === "object" && !Array.isArray(data) ? data : {};
  return node.result && typeof node.result === "object" && !Array.isArray(node.result) ? node.result : {};
}

// 提交：MediaKit 的 video_url 只接受公网 http(s)/vod:///tos://，出站就用调用方给的字段。
export function buildSubmitRequest(ctx) {
  const req = ctx.requestBody || {};
  const videoURL = trimmed(req.video_url) || trimmed(req.url) || trimmed(req.input_video);
  if (!videoURL) throw new Error("field video_url is required");
  const body = { video_url: videoURL };
  for (const key of ["tool_version", "resolution", "resolution_limit", "fps", "bit_depth", "bitrate_level", "scene", "client_token", "queue_id", "media_output_destination", "callback_url", "callback_args"]) {
    if (req[key] !== undefined && req[key] !== null && req[key] !== "") body[key] = req[key];
  }
  return {
    url: ctx.baseUrl + "/api/v1/tools/enhance-video",
    method: "POST",
    headers: { Authorization: "Bearer " + ctx.apiKey, "Content-Type": "application/json" },
    body: body,
  };
}

export function parseSubmitResponse(ctx, resp) {
  const body = resp.body || {};
  const taskId = trimmed(body.task_id);
  if (!taskId) throw new Error("task_id is empty");
  if (!isOK(body)) {
    const message = body.error && body.error.message ? body.error.message : "enhance submit rejected";
    throw new Error(message);
  }
  return { taskId: taskId, taskData: body };
}

export function buildQueryRequest(ctx) {
  return {
    url: ctx.baseUrl + "/api/v1/tasks/" + encodeURIComponent(ctx.taskId),
    method: "GET",
    headers: { Authorization: "Bearer " + ctx.apiKey },
  };
}

// 轮询结果：running → IN_PROGRESS；completed → SUCCESS（result.video_url/duration/fps/resolution）；
// failed → FAILURE。参数/鉴权错误是同步 200 + success:false，这里也按失败处理。
export function parseTaskResult(ctx, body) {
  const data = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const status = trimmed(data.status).toLowerCase();
  const result = resultNode(data);
  const output = { status: "UNKNOWN" };
  if (status === "completed" || status === "success" || status === "succeeded") {
    output.status = "SUCCESS";
    output.progress = "100%";
    const url = trimmed(result.video_url);
    if (url) output.url = url;
  } else if (status === "failed" || status === "cancelled" || status === "canceled") {
    output.status = "FAILURE";
    output.progress = "100%";
    const message = (data.error && data.error.message) || data.message || "enhance failed";
    output.reason = trimmed(message);
  } else if (status === "running" || status === "processing" || status === "in_progress") {
    output.status = "IN_PROGRESS";
  } else if (status === "queued" || status === "pending" || status === "submitted" || status === "created") {
    output.status = "QUEUED";
  } else {
    output.reason = "unrecognized status: " + status;
  }
  if (data.success === false && output.status !== "FAILURE") {
    const message = (data.error && data.error.message) || "enhance rejected";
    output.status = "FAILURE";
    output.reason = trimmed(message);
  }
  return output;
}

export function listArtifacts(task) {
  return task.status === "SUCCESS" ? [{ key: "video", type: "video" }] : [];
}

// 成片直链：result.video_url（配置了 output bucket 时由中转侧先解析成可下载的 https）。
// 直链源站对 HEAD 不友好，客户端问 HEAD 时改用 GET 去取（宿主只回响应头）。
export function buildContentRequest(ctx) {
  if (ctx.artifactKey !== "video") throw new Error("artifact_not_found");
  const data = ctx.data && typeof ctx.data === "object" && !Array.isArray(ctx.data) ? ctx.data : {};
  const directURL = trimmed(resultNode(data).video_url) || trimmed(data.video_url);
  const clientMethod = trimmed(ctx.clientRequest && ctx.clientRequest.method) || "GET";
  const method = clientMethod.toUpperCase() === "HEAD" ? "GET" : clientMethod;
  if (/^https?:\/\//i.test(directURL)) return { url: directURL, method: method, credentialless: true };
  return {
    url: ctx.baseUrl + "/api/v1/tasks/" + encodeURIComponent(ctx.upstreamTaskId),
    method: "GET",
    headers: { Authorization: "Bearer " + ctx.apiKey },
  };
}

// 计费口径：按输出时长（秒）。legacy 倍率路径恒为 1，避免把秒数当倍率放大单价。
export function extractUsage(ctx) {
  if (ctx.usagePurpose === "billing_ratios") return { seconds: 1 };
  const req = ctx.requestBody || {};
  const seconds = Number(req.duration || req.seconds);
  return { seconds: Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 3600) : 1 };
}

// 完成结算：用 MediaKit 返回的真实输出时长覆盖估算值。
export function extractUsageOnComplete(task, taskResult, body) {
  const data = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const seconds = Number(resultNode(data).duration);
  if (!Number.isFinite(seconds) || seconds <= 0) return {};
  return { seconds: Math.min(seconds, 3600) };
}

// ---------------------------------------------------------------------------
// openai_responses 协议：超分模型既能被中转内部子任务调用，也支持客户端两步
// 手动调用（先出片，再拿视频地址调超分）。输入就是一个视频地址，不涉及参考图。
// ---------------------------------------------------------------------------
function responsesVideoInput(req) {
  for (const value of [req.video_url, req.video, req.input_video, req.url]) {
    const url = trimmed(value);
    if (url) return url;
  }
  const input = req.input;
  if (typeof input === "string" && /^https?:\/\//i.test(trimmed(input))) return trimmed(input);
  if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item === "string" && /^https?:\/\//i.test(trimmed(item))) return trimmed(item);
    }
  }
  return "";
}

function enhanceVideoOutput(ctx) {
  const data = ctx && ctx.data && typeof ctx.data === "object" ? ctx.data : {};
  const url = trimmed(resultNode(data).video_url) || trimmed(data.video_url);
  if (!url) throw new Error("enhanced video is unavailable");
  return '<video controls src="' + url.replace(/&/g, "&amp;").replace(/"/g, "&quot;") + '"></video>';
}

export const protocols = {
  openai_responses: {
    decodeRequest: function (ctx) {
      if (!ctx.body || ctx.body.kind !== "json") throw new Error("JSON body required");
      const req = ctx.body.value;
      if (!req || typeof req !== "object" || Array.isArray(req)) throw new Error("request body must be an object");
      const model = trimmed(req.model);
      if (!model) throw new Error("model is required");
      const videoURL = responsesVideoInput(req);
      if (!videoURL) throw new Error("video_url is required");
      const requestBody = { video_url: videoURL };
      for (const key of ["tool_version", "resolution", "resolution_limit", "fps", "bit_depth", "bitrate_level", "scene", "media_output_destination", "callback_url", "callback_args"]) {
        if (req[key] !== undefined) requestBody[key] = req[key];
      }
      return { kind: "submit", model: model, action: "video_enhance", requestBody: requestBody };
    },
    renderEvents: function (ctx, task, previousState) {
      const status = String((task && task.status) || "UNKNOWN").toUpperCase();
      const value = Number(String((task && task.progress) || "").replace("%", ""));
      const progress = Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
      const state = { status: status, progress: progress };
      if (status === "SUCCESS") {
        const text = enhanceVideoOutput(ctx);
        const events = previousState && previousState.status === status ? [] : [{ type: "output", data: text }];
        return { events: events, state: state, done: true };
      }
      if (status === "FAILURE") {
        return {
          events: [{ type: "error", code: "task_failed", message: (task && task.fail_reason) || "task failed" }],
          state: state,
          done: true,
        };
      }
      if (previousState && previousState.status === status && previousState.progress === progress) {
        return { events: [], state: state, done: false };
      }
      const event = { type: "progress", message: status.toLowerCase() };
      if (progress !== null) event.progress = progress;
      return { events: [event], state: state, done: false };
    },
    renderFinal: function (ctx) {
      return {
        output: [
          {
            type: "message",
            status: "completed",
            role: "assistant",
            content: [{ type: "output_text", text: enhanceVideoOutput(ctx), annotations: [], logprobs: [] }],
          },
        ],
        metadata: { vendor: "mediakit" },
      };
    },
  },
};
