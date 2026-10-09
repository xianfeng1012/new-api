// 视频桥接（newapi-video-bridge 等 Sora 协议兼容上游）通过 55 号渠道提供的模型。
// 渠道按类型选中本插件，但计费配置（计费与支付 → 模型定价）按模型名解析 usage schema，
// 因此这些模型必须在此声明，才能解析出 seconds 字段并配置「按秒计费」。
// 新增/改名桥接模型时同步更新此列表。
const BRIDGE_VIDEO_MODELS = ["seedance_v2.0", "seedance_v2.0_std", "seedance_v2.5", "seedance-2.0", "seedance-2.5"];
const MEAICC_VIDEO_MODELS = ["sd-2.5-c1", "sd-2-c4"];

export const meta = {
  apiVersion: 1,
  key: "sora",
  name: "Sora",
  icon: "Sora.Color",
  description: {
    en: "OpenAI Sora video generation (text-to-video, image-to-video, and remix)",
    zh: "OpenAI Sora 视频生成（文生视频、图生视频、remix）",
  },
  version: "1.0.18",
  channelTypes: [55, 1], // OpenAI-type channels natively serve sora with the same wire format
  author: { name: "QuantumNous" },
  models: ["sora-2", "sora-2-pro"].concat(BRIDGE_VIDEO_MODELS, MEAICC_VIDEO_MODELS),
  fetchMode: "per_task",
  // A New API gateway serves /v1/videos as a host protocol, so no URL changes.
  upstreams: ["vendor", "new_api"],
  usageSchema: {
    // Requested video duration in seconds.
    seconds: {
      type: "number",
      unit: "second",
      description: { en: "Video generation unit price", zh: "视频生成单价" },
    },
  },
  usageExamples: [{ label: "5s", facts: { seconds: 5 } }],
  protocols: [{ name: "openai_responses", supports: ["stream", "sync", "background"] }, "openai_video"],
};
// 画布（infinite-canvas）等 OpenAI-Videos 客户端按「首尾帧 / 全能参考」模式发参考图，
// 字段名有 input_reference / input_reference[] / image / image[] / first_frame / last_frame
// 等多种写法，语义都是同一张参考图。这里统一识别，避免按裸名严格等值把请求打死。
function isReferenceImageField(name) {
  const bare = String(name == null ? "" : name).trim().replace(/\[\]$/, "");
  return (
    bare === "input_reference" ||
    bare === "image" ||
    bare === "images" ||
    bare === "reference_image" ||
    bare === "reference_images" ||
    bare === "first_frame" ||
    bare === "last_frame"
  );
}

function trimmed(value) {
  return String(value || "").trim();
}

// reference_images / reference_image 是画布与视频桥接实际使用的字段，必须透传给上游，
// 否则图生视频会在中途被丢弃（只剩 prompt）。
function collectReferenceImages(req) {
  const images = [];
  const raw = [].concat(req.reference_images || [], req.reference_image || []);
  for (const item of raw) {
    const value = trimmed(item && typeof item === "object" ? item.url : item);
    if (value && !images.includes(value)) images.push(value);
  }
  return images;
}

function responsesInput(req) {
  const texts = [],
    images = [];
  const input = req.input;
  if (typeof input === "string") texts.push(input);
  else if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item === "string") {
        texts.push(item);
        continue;
      }
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const content = item.content === undefined ? [item] : Array.isArray(item.content) ? item.content : [item.content];
      for (const part of content) {
        if (typeof part === "string") {
          texts.push(part);
          continue;
        }
        if (!part || typeof part !== "object" || Array.isArray(part)) continue;
        if (["input_text", "text"].includes(part.type) && typeof part.text === "string") texts.push(part.text);
        if (["input_image", "image_url"].includes(part.type)) {
          let image = part.image_url;
          if (image && typeof image === "object") image = image.url;
          if (trimmed(image)) images.push(trimmed(image));
        }
      }
    }
  }
  return {
    prompt: texts
      .filter(function (text) {
        return trimmed(text);
      })
      .join("\n"),
    images: images,
  };
}

function responsesVideoText(ctx) {
  const artifact = ctx && ctx.artifacts && ctx.artifacts.video;
  const url = trimmed(artifact && artifact.url);
  if (!url) throw new Error("video artifact is unavailable");
  const escaped = url.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return '<video controls src="' + escaped + '"></video>';
}

// 出站时长归一化：不同画布工具/前置代理给的时长字段形状不一。
// 顶层秒数缺失或像是占位值（<=1）时，依次从桥接带入的真值字段、duration、
// metadata 里取真实时长；命中的值统一换算成「秒数字符串」。上限沿用任务时长
// 上限（3600s），异常值不会放大。
function outboundSeconds(req) {
  const source = req && typeof req === "object" ? req : {};
  const metadata = source.metadata && typeof source.metadata === "object" && !Array.isArray(source.metadata) ? source.metadata : {};
  for (const candidate of [source.seconds, source._billing_seconds, source.duration, metadata.seconds, metadata.duration]) {
    const value = Number(candidate);
    if (Number.isFinite(value) && value > 1) return String(Math.min(value, 3600));
  }
  return undefined;
}

// 非 meaicc 上游的出站归一化（meaicc 走上面的 input/parameters 重组，不经过这里）。
// 两条硬规则（2026-10-09 两次下游 400 后收敛）：
// 1) 一律不发 duration —— 上游（New API 系）把它解析成整数字段，multipart 只能以
//    字符串承载，出现即炸 invalid_json：cannot unmarshal string into ... .duration of type int；
// 2) seconds 一律发字符串 —— 同族上游该字段是 string，发数字会炸
//    cannot unmarshal number into ... .seconds of type string。
// 只改发给上游的 body —— 计费倍率读的是 ctx.requestBody，不受影响。
function requestValues(req, model) {
  const values = Object.assign({}, req || {});
  values.model = model;
  delete values.duration;
  const seconds = outboundSeconds(req);
  if (seconds === undefined) delete values.seconds;
  else values.seconds = seconds;
  return values;
}

// 兼容旧调用点：与 requestValues 共用同一条归一化路径。
function submissionValues(req, model) {
  return requestValues(req, model);
}

// ---------------------------------------------------------------------------
// meaicc (api.meaicc.com) 上游适配
//
// meaicc 的 /v1/videos 不是 OpenAI Videos 语义，它只认自家文档那一套：
//   { model, input: { prompt, media: [{ type, url }] },
//     parameters: { resolution, ratio, duration } }
// - 顶层 prompt 它不看，真正的提示词只在 input.prompt；
// - parameters.duration 必须是 JSON 整数；顶层 duration 一旦出现也必须是整数，
//   否则上游直接 400：
//     json: cannot unmarshal string into Go struct field .Alias.duration of type int
// 因此这里把宿主归一化后的请求重新组装成 meaicc 的形状，并把所有时长字段
// （duration / seconds / metadata.*）压成整数再夹到它接受的范围。
//
// 出站 body 会先由 protocols.*.decodeRequest 组装一次，再被 buildSubmitRequest
// 走一遍，所以下面每个取值都同时认「画布原始字段」和「已组装好的 meaicc 形状」，
// 保证重复执行不丢字段。
const MEAICC_DURATION_MIN = 5;
const MEAICC_DURATION_MAX = 15;

function isMeaicc(ctx) {
  // 上游域名或模型名任一命中即按 meaicc 形状出站：渠道换域名、走代理，
  // 或本地用假上游联调时都不会漏判。
  if (/meaicc\.com/i.test(String((ctx && ctx.baseUrl) || ""))) return true;
  const model = String((ctx && (ctx.upstreamModel || ctx.model)) || "").trim();
  return MEAICC_VIDEO_MODELS.indexOf(model) >= 0;
}

function meaiccParameters(req) {
  return req.parameters && typeof req.parameters === "object" && !Array.isArray(req.parameters) ? req.parameters : {};
}

function meaiccSeconds(req) {
  const parameters = meaiccParameters(req);
  const metadata = req.metadata && typeof req.metadata === "object" && !Array.isArray(req.metadata) ? req.metadata : {};
  for (const candidate of [parameters.duration, req.duration, req.seconds, metadata.duration, metadata.seconds, req._billing_seconds]) {
    const value = Number(candidate);
    if (Number.isFinite(value) && value > 0) {
      return Math.min(Math.max(Math.round(value), MEAICC_DURATION_MIN), MEAICC_DURATION_MAX);
    }
  }
  return 5;
}

function parseSize(value) {
  const matched = trimmed(value).match(/^(\d{2,5})\s*[x*\u00d7]\s*(\d{2,5})$/);
  if (!matched) return null;
  return { width: Number(matched[1]), height: Number(matched[2]) };
}

function meaiccResolution(req) {
  const fromParameters = trimmed(meaiccParameters(req).resolution).match(/(\d{3,4})\s*p/i);
  if (fromParameters) return fromParameters[1] + "p";
  const matched = trimmed(req.resolution).match(/(\d{3,4})\s*p/i);
  if (matched) return matched[1] + "p";
  const size = parseSize(req.size);
  if (size) {
    // WxH -> 分辨率档：按短边判定（1280x720 与 720x1280 都是 720p）。
    const shortSide = Math.min(size.width, size.height);
    if (shortSide >= 1080) return "1080p";
    if (shortSide >= 720) return "720p";
    return "480p";
  }
  return "720p";
}

function meaiccRatio(req) {
  const fromParameters = trimmed(meaiccParameters(req).ratio);
  if (/^\d+\s*:\s*\d+$/.test(fromParameters)) return fromParameters.replace(/\s+/g, "");
  const raw = trimmed(req.ratio) || trimmed(req.aspect_ratio);
  if (/^\d+\s*:\s*\d+$/.test(raw)) return raw.replace(/\s+/g, "");
  const size = parseSize(req.size);
  if (size) return size.width > size.height ? "16:9" : size.width < size.height ? "9:16" : "1:1";
  return "16:9";
}

// 画布 / 桥接给的参考图字段名不统一，按固定顺序合并去重，并保留字段名：
// first_frame / last_frame -> images[] -> image -> input_reference -> reference_images[] -> reference_image
function meaiccImageEntries(req) {
  const entries = [];
  const seen = {};
  const push = function (value, name) {
    const url = trimmed(value && typeof value === "object" ? value.url : value);
    if (!url || seen[url]) return;
    seen[url] = true;
    entries.push({ name: trimmed(name), url: url });
  };
  push(req.first_frame, "first_frame");
  push(req.last_frame, "last_frame");
  for (const value of [].concat(req.images || [])) push(value, "images");
  push(req.image, "image");
  push(req.input_reference, "input_reference");
  for (const value of [].concat(req.reference_images || [])) push(value, "reference_images");
  push(req.reference_image, "reference_image");
  return entries;
}

// 画布上传的图片是 multipart 文件（没有 URL）。宿主支持把
// {"__fileRef":…, "encoding":"dataUrl"} 占位符内联成 data:image/png;base64,…，
// 而 meaicc 的 input.media[].url 实测接受 data: URL（文档只要求 URL 地址，
// 但参考图/首帧图它都能直接内联），所以这里把上传字节交给宿主内联。
function meaiccFileEntries(ctx) {
  const entries = [];
  for (const file of (ctx && ctx.files) || []) {
    const ref = trimmed(file && file.ref);
    if (!ref) continue;
    entries.push({
      name: trimmed(file.field),
      fileRef: ref,
      mimeType: trimmed(file.mimeType),
      filename: trimmed(file.filename),
    });
  }
  return entries;
}

function meaiccFrameType(name) {
  const bare = trimmed(name).toLowerCase().replace(/\[\]$/, "");
  if (bare === "first_frame") return "first_frame";
  if (bare === "last_frame") return "last_frame";
  return "";
}

// 单图 = 图生视频（first_frame）；多图 = 参考生视频（reference_image，提示词用图1/图2 指代）；
// 显式 first_frame / last_frame 字段名或 mode=frames 一律照办。
function meaiccMediaType(entry, index, total, framesMode) {
  const explicit = meaiccFrameType(entry.name);
  if (explicit) return explicit;
  if (framesMode && index < 2) return index === 0 ? "first_frame" : "last_frame";
  return total > 1 ? "reference_image" : "first_frame";
}

function meaiccMedia(req, ctx) {
  const entries = meaiccImageEntries(req).concat(meaiccFileEntries(ctx));
  if (!entries.length) {
    // 客户端直接按 meaicc 文档形状提交（input.media 已组装好）时原样保留。
    const existing = req.input && Array.isArray(req.input.media) ? req.input.media : [];
    const kept = [];
    for (const item of existing) {
      const url = trimmed(item && typeof item === "object" ? item.url : item);
      if (url) kept.push({ type: trimmed(item && item.type) || "reference_image", url: url });
    }
    if (kept.length) return kept;
  }
  const framesMode = trimmed(req.mode) === "frames";
  const media = [];
  entries.forEach(function (entry, index) {
    const type = meaiccMediaType(entry, index, entries.length, framesMode);
    if (entry.fileRef) {
      const placeholder = { __fileRef: entry.fileRef, encoding: "dataUrl" };
      if (entry.mimeType) placeholder.mimeType = entry.mimeType;
      media.push({ type: type, url: placeholder });
    } else {
      media.push({ type: type, url: entry.url });
    }
  });
  for (const value of [].concat(req.reference_audios || [])) {
    const url = trimmed(value && typeof value === "object" ? value.url : value);
    if (url) media.push({ type: "reference_voice", url: url });
  }
  return media;
}

function meaiccSubmitBody(req, model, ctx) {
  // prompt 认两种形状：画布原始顶层 prompt，以及已组装好的 input.prompt。
  const nested = req.input && typeof req.input === "object" && !Array.isArray(req.input) ? trimmed(req.input.prompt) : "";
  const prompt = trimmed(req.prompt) || nested;
  const input = { prompt: prompt };
  const media = meaiccMedia(req, ctx);
  if (media.length) input.media = media;
  return {
    model: model,
    prompt: prompt,
    input: input,
    parameters: { resolution: meaiccResolution(req), ratio: meaiccRatio(req), duration: meaiccSeconds(req) },
  };
}

// decodeRequest 侧：只有 meaicc 命中时替换 intent 里的 requestBody。
function meaiccRequest(ctx, req) {
  if (!isMeaicc(ctx)) return null;
  return meaiccSubmitBody(req, (ctx && (ctx.upstreamModel || ctx.model)) || "", ctx);
}

// buildSubmitRequest 侧：meaicc 走重组后的 body，其余上游保持原样。
export function buildSubmitRequest(ctx) {
  const req = ctx.requestBody || {};
  if (!String(req.prompt || "").trim()) throw new Error("field prompt is required");
  const action = ctx.action === "remix" ? "remix" : ctx.action;
  const headers = { Authorization: "Bearer " + ctx.apiKey };
  if (action === "remix") {
    headers["Content-Type"] = "application/json";
    return { url: ctx.baseUrl + "/v1/videos/" + ctx.originTaskId + "/remix", method: "POST", headers, body: submissionValues(req, ctx.upstreamModel), action };
  }
  if (isMeaicc(ctx)) {
    headers["Content-Type"] = "application/json";
    return { url: ctx.baseUrl + "/v1/videos", method: "POST", headers, body: meaiccSubmitBody(req, ctx.upstreamModel, ctx) };
  }
  if ((ctx.files || []).length) {
    const parts = [];
    const values = submissionValues(req, ctx.upstreamModel);
    for (const key of Object.keys(values)) {
      if (values[key] !== undefined && values[key] !== null && typeof values[key] !== "object") parts.push({ name: key, value: values[key] });
    }
    if (values.metadata && typeof values.metadata === "object" && !Array.isArray(values.metadata)) {
      parts.push({ name: "metadata", value: JSON.stringify(values.metadata) });
    }
    for (const file of ctx.files) parts.push({ name: "input_reference", fileRef: file.ref, filename: file.filename });
    return { url: ctx.baseUrl + "/v1/videos", method: "POST", headers, bodyType: "multipart", parts };
  }
  headers["Content-Type"] = "application/json";
  return { url: ctx.baseUrl + "/v1/videos", method: "POST", headers, body: meaiccRequest(ctx, req) || submissionValues(req, ctx.upstreamModel) };
}

export function parseSubmitResponse(ctx, resp) {
  const body = resp.body || {};
  const taskId = body.id || body.task_id;
  if (!taskId) throw new Error("task_id is empty");
  return { taskId, taskData: body };
}

// 真实视频时长（秒）：桥接在 JSON 提交里注入 _billing_seconds 真值；
// 画布直连的 multipart 不经桥接改写，退回请求体的 duration/seconds。
// 上限沿用任务时长上限（3600s），异常值不会放大计费。
function billingSeconds(req) {
  const metadata = req.metadata && typeof req.metadata === "object" && !Array.isArray(req.metadata) ? req.metadata : {};
  for (const candidate of [req._billing_seconds, req.duration, metadata.seconds, metadata.duration, req.seconds]) {
    const value = Number(candidate);
    if (Number.isFinite(value) && value > 0) return Math.min(value, 3600);
  }
  return 1;
}

// 计费口径分两条互不影响的路径：
// - 按次计费：legacy ratio 路径（ModelPrice 固定单价 / 模型倍率）读 billing_ratios，
//   倍率恒为 1，时长不参与倍率。历史坑（2026-09-21）：曾把客户端 seconds 当倍率返回，
//   ¥/次 被放大成 ¥×(秒数)/次，因此这里必须保持 1。
// - 按秒计费：task 表达式路径读 facts，返回真实时长（秒），配合「视频生成单价（每秒）」。
export function extractUsage(ctx) {
  if (ctx.action === "remix") return {};
  const req = ctx.requestBody || {};
  const size = req.size || "720x1280";
  if (ctx.usagePurpose === "billing_ratios") return { seconds: 1, size: size };
  return { seconds: billingSeconds(req), size: size };
}

// 完成结算：上游不回传真实时长，因此不回写 seconds，保留提交阶段估算的真实时长，
// 避免用 1 覆盖表达式计费的按秒金额。legacy ratio 路径不返回倍率同样等价于按次。
export function extractUsageOnComplete(task, taskResult, body) {
  const facts = {};
  const size = trimmed((body || {}).size);
  if (["720x1280", "1280x720", "1792x1024", "1024x1792"].includes(size)) facts.size = size;
  return facts;
}

export function buildQueryRequest(ctx) {
  return { url: ctx.baseUrl + "/v1/videos/" + ctx.taskId, method: "GET", headers: { Authorization: "Bearer " + ctx.apiKey } };
}

// 上游状态映射：meaicc 用 RUNNING / SUCCEEDED / "FAILED: xxx"（大写），
// 视频桥接 / 号池用 queued / in_progress / completed / failed。两套都认。
export function parseTaskResult(ctx, body) {
  const data = body && typeof body === "object" ? body : {};
  const raw = trimmed(data.status);
  const result = { status: "UNKNOWN" };
  if (/^(succeeded|success|completed|done)$/i.test(raw)) {
    result.status = "SUCCESS";
  } else if (/^(failed|cancel|cancelled|canceled)/i.test(raw)) {
    result.status = "FAILURE";
    result.reason = trimmed(raw.replace(/^failed\s*:?\s*/i, "")) || "task failed";
  } else if (/^(queued|not_start|pending|created|submitted)$/i.test(raw)) {
    result.status = "QUEUED";
  } else if (/^(running|processing|in_?progress)$/i.test(raw)) {
    result.status = "IN_PROGRESS";
  } else {
    result.reason = "unrecognized status: " + raw;
  }
  const progress = Number(data.progress);
  if (Number.isFinite(progress) && progress > 0 && progress < 100) result.progress = progress + "%";
  if (result.status === "FAILURE" && !result.reason) {
    result.reason = data.error && data.error.message ? data.error.message : "task failed";
  }
  const url = artifactVideoURL(data);
  if (url) result.url = url;
  return result;
}

export function listArtifacts(task) {
  return task.status === "SUCCESS" ? [{ key: "video", type: "video" }] : [];
}

// 任务数据里若已带视频直链（号池/上游返回的 video.url / url），优先直连。
// 上游 /content 代理不可用时（例如上游本身 502），带 access 的能力请求会把失败
// 掩码成 404，表现就是「任务日志 → 制品」里的视频打不开。直链按 credentialless
// 取用，不携带渠道密钥。
function artifactVideoURL(data) {
  let node = data && typeof data === "object" && !Array.isArray(data) ? data : {};
  for (let depth = 0; depth < 2; depth += 1) {
    const video = node.video && typeof node.video === "object" && !Array.isArray(node.video) ? node.video : {};
    for (const candidate of [video.url, video.video_url, node.url, node.video_url, node.object, node.output, node.play_url]) {
      const value = trimmed(candidate);
      if (/^https?:\/\//i.test(value)) return value;
    }
    node = node.data && typeof node.data === "object" && !Array.isArray(node.data) ? node.data : {};
  }
  return "";
}

export function buildContentRequest(ctx) {
  if (ctx.artifactKey !== "video") throw new Error("artifact_not_found");
  const directURL = artifactVideoURL(ctx.data);
  if (directURL) return { url: directURL, method: ctx.clientRequest.method, credentialless: true };
  return {
    url: ctx.baseUrl + "/v1/videos/" + encodeURIComponent(ctx.upstreamTaskId) + "/content",
    method: ctx.clientRequest.method,
    headers: { Authorization: "Bearer " + ctx.apiKey },
  };
}

export const protocols = {
  openai_responses: {
    decodeRequest: function (ctx) {
      if (!ctx.body || ctx.body.kind !== "json") throw new Error("JSON body required");
      const req = ctx.body.value;
      if (!req || typeof req !== "object" || Array.isArray(req)) throw new Error("request body must be an object");
      const model = trimmed(req.model);
      if (!model) throw new Error("model is required");
      if (req.input !== undefined && typeof req.input !== "string" && !Array.isArray(req.input)) throw new Error("input must be a string or array");
      if (req.images !== undefined && !Array.isArray(req.images)) throw new Error("images must be an array");
      if (req.metadata !== undefined && (!req.metadata || typeof req.metadata !== "object" || Array.isArray(req.metadata)))
        throw new Error("metadata must be an object");
      const input = responsesInput(req);
      const prompt = input.prompt || trimmed(req.prompt);
      if (!prompt) throw new Error("input is required");
      const images = [];
      for (const image of [req.image, req.input_reference].concat(req.images || [], input.images)) {
        if (trimmed(image) && !images.includes(trimmed(image))) images.push(trimmed(image));
      }
      const requestBody = { model: model, prompt: prompt };
      if (images.length) requestBody.input_reference = images[0];
      const referenceImages = collectReferenceImages(req);
      if (referenceImages.length) requestBody.reference_images = referenceImages;
      if (Object.prototype.hasOwnProperty.call(req, "seconds")) requestBody.seconds = req.seconds;
      else if (Object.prototype.hasOwnProperty.call(req, "duration")) requestBody.seconds = req.duration;
      // 前置桥接把真实时长放在私有字段 _billing_seconds，顶层 seconds 只是占位值。
      // 透传它，按秒计费与出站时长归一化才能读到真值（与 openai_video 路径一致）。
      if (Object.prototype.hasOwnProperty.call(req, "_billing_seconds")) requestBody._billing_seconds = req._billing_seconds;
      if (Object.prototype.hasOwnProperty.call(req, "size")) requestBody.size = req.size;
      if (Object.prototype.hasOwnProperty.call(req, "metadata")) requestBody.metadata = req.metadata;
      // 其余视频参数按原样透传；故意不含 seconds —— 它同时是计费倍率（一口价时为 1），
      // 真实时长放在 metadata 里，由号池解析。
      for (const key of ["duration", "ratio", "aspect_ratio", "resolution", "generate_audio", "count", "reference_audios"]) {
        if (req[key] !== undefined) requestBody[key] = req[key];
      }
      return {
        kind: "submit",
        model: model,
        action: images.length || referenceImages.length ? "image_to_video" : "text_to_video",
        requestBody: meaiccRequest(ctx, requestBody) || requestBody,
      };
    },
    renderEvents: function (ctx, task, previousState) {
      const status = String(task.status || "UNKNOWN").toUpperCase();
      const value = Number(String(task.progress || "").replace("%", ""));
      const progress = Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
      const state = { status: status, progress: progress };
      if (status === "SUCCESS") {
        const text = responsesVideoText(ctx);
        const events = previousState && previousState.status === status ? [] : [{ type: "output", data: text }];
        return { events: events, state: state, done: true };
      }
      if (status === "FAILURE")
        return { events: [{ type: "error", code: "task_failed", message: task.fail_reason || "task failed" }], state: state, done: true };
      if (previousState && previousState.status === status && previousState.progress === progress) return { events: [], state: state, done: false };
      const event = { type: "progress", message: status.toLowerCase() };
      if (progress !== null) event.progress = progress;
      return { events: [event], state: state, done: false };
    },
    renderFinal: function (ctx, _task) {
      return {
        output: [
          {
            type: "message",
            status: "completed",
            role: "assistant",
            content: [{ type: "output_text", text: responsesVideoText(ctx), annotations: [], logprobs: [] }],
          },
        ],
        metadata: { vendor: "sora" },
      };
    },
  },
};

const legacyRenderers = {
  openai_video: function (task) {
    const statuses = { NOT_START: "queued", SUBMITTED: "queued", QUEUED: "queued", IN_PROGRESS: "in_progress", SUCCESS: "completed", FAILURE: "failed" };
    const output = {
      id: task.task_id,
      object: "video",
      model: (task.properties || {}).origin_model_name || "",
      status: statuses[task.status] || "unknown",
      progress: Number(String(task.progress || "0").replace("%", "")),
      created_at: Number(task.created_at || 0),
    };
    const completedAt = Number(task.finished_at || task.updated_at || 0);
    if (completedAt > 0) output.completed_at = completedAt;
    if (task.status === "FAILURE") {
      output.error = { code: "video_generation_failed", message: "The video generation task failed." };
    }
    return output;
  },
};

protocols.openai_video = {
  decodeRequest: function (ctx) {
    if (!ctx.body || (ctx.body.kind !== "json" && ctx.body.kind !== "multipart")) throw new Error("JSON or multipart body required");
    if (ctx.body.kind === "json") {
      if (!ctx.body.value || Array.isArray(ctx.body.value)) throw new Error("JSON object required");
      const req = ctx.body.value;
      const seconds = req.seconds === undefined ? req.duration : req.seconds;
      if (seconds !== undefined && (!Number.isFinite(Number(seconds)) || Number(seconds) <= 0 || Number(seconds) > 3600))
        throw new Error("seconds must be between 1 and 3600");
      return {
        kind: "submit",
        model: ctx.model,
        action: req.input_reference || req.image || req.reference_images || req.reference_image ? "image_to_video" : "text_to_video",
        requestBody: meaiccRequest(ctx, req) || Object.assign({}, req, { model: ctx.model }),
      };
    }
    const first = function (name) {
      const values = (ctx.body.fields || {})[name] || [];
      if (values.length > 1) throw new Error(name + " must be provided once");
      return values[0];
    };
    const req = {};
    const fields = ctx.body.fields || {};
    for (const name of Object.keys(fields)) {
      req[name] = first(name);
    }
    let hasInputReferenceFile = false;
    let referenceFileCount = 0;
    for (const file of ctx.body.files || []) {
      if (!isReferenceImageField(file.field)) throw new Error("unexpected file field: " + file.field);
      referenceFileCount += 1;
      if (referenceFileCount > 9) throw new Error("at most 9 reference images are supported");
      hasInputReferenceFile = true;
    }
    if (req.metadata !== undefined) {
      let parsed;
      try {
        parsed = JSON.parse(req.metadata);
      } catch (e) {
        throw new Error("metadata must be a JSON object string");
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("metadata must be a JSON object string");
      req.metadata = parsed;
    }
    if (req.seconds !== undefined) req.seconds = Number(req.seconds);
    else if (req.duration !== undefined) req.seconds = Number(req.duration);
    const seconds = req.seconds === undefined ? req.duration : req.seconds;
    if (seconds !== undefined && (!Number.isFinite(Number(seconds)) || Number(seconds) <= 0 || Number(seconds) > 3600))
      throw new Error("seconds must be between 1 and 3600");
    return {
      kind: "submit",
      model: ctx.model,
      action: hasInputReferenceFile || req.input_reference || req.image || req.reference_images || req.reference_image ? "image_to_video" : "text_to_video",
      requestBody: meaiccRequest(ctx, req) || Object.assign({}, req, { model: ctx.model }),
    };
  },
  render: function (ctx, task) {
    if (task.data && typeof task.data === "object" && !Array.isArray(task.data)) return task.data;
    return legacyRenderers.openai_video(task);
  },
};

