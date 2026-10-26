import { decodeInventoryFile, parseInventory, createInventoryReport } from "./inventory.mjs";
import { renderInventoryReport } from "./inventory-report.mjs";

const MAX_BYTES = 1024 * 1024;
const EN = String(document.documentElement?.lang || "zh-CN").toLowerCase().startsWith("en");
const t = (zh, en) => EN ? en : zh;
const $ = id => document.getElementById(id);
const input = $("inventory-input");
const fileInput = $("inventory-file");
let index = null;
let entries = [];
let selections = {};
let report = null;
let reportHtml = null;
let demonstration = false;
let revision = 0;
let downloadUrl = null;
let pendingImport = null;

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (className) node.className = className;
  return node;
}

function clearError() { $("page-error").hidden = true; $("page-error").textContent = ""; }
function showError(error) {
  $("page-error").textContent = error instanceof Error ? error.message : String(error);
  $("page-error").hidden = false;
  $("page-error").focus();
}
function setStatus(text) { $("work-status").textContent = text; }
function setPendingImport(value) {
  pendingImport = value;
  $("compare-button").disabled = Boolean(value) || !index;
  $("preview-button").disabled = Boolean(value);
  $("inventory-form").setAttribute("aria-busy", String(Boolean(value)));
}
function importingStatus() {
  return t("正在读取“", "Reading “") + pendingImport.name + t("”。旧报告已失效，请等待读取完成后再核对或生成预览。", "”. The previous report is invalid; wait for the read to finish before comparing or previewing.");
}
function blockWhileImporting() {
  if (!pendingImport) return false;
  setStatus(importingStatus());
  return true;
}
function invalidatePreview(message = t("材料已变更，请重新生成报告预览。", "The material changed. Generate a new report preview.")) {
  reportHtml = null;
  if (downloadUrl) { URL.revokeObjectURL(downloadUrl); downloadUrl = null; }
  $("download-button").disabled = true;
  $("report-preview").removeAttribute("srcdoc");
  $("preview-section").hidden = true;
  $("preview-status").textContent = message;
}
function invalidateInput() {
  revision += 1;
  setPendingImport(null);
  invalidatePreview();
  entries = [];
  selections = {};
  report = null;
  $("results-section").hidden = true;
  $("inventory-items").replaceChildren();
}

function indexDescription() {
  const box = $("index-status");
  box.replaceChildren();
  const sample = index.snapshot === true || index.sample === true || /sample|样本|示例/i.test(String(index.snapshot || ""));
  box.classList.toggle("sample", sample);
  box.append(element("strong", sample ? t("正在使用样本目录", "Using a sample index") : t("正在使用已有历史快照", "Using an existing historical snapshot")));
  box.append(element("p", t("生成时间：", "Generated: ") + (index.generatedAt || t("未提供", "not provided")) + t(" · 本页记录：", " · records on this page: ") + index.records.length + t(" · 目录总数：", " · index total: ") + (index.total ?? index.count ?? index.records.length)));
  box.append(element("p", sample ? t("样本用于演示，不能代表完整目录或最新状态。即使名称和版本相同，也不能用样本证明实际情况。", "The sample is for demonstration and does not represent a complete or current index. Matching names and versions do not make it evidence of your installation.") : t("此页面不会重新联网查询目录；版本与时间以每条记录为准，历史资料不代表当前运行情况。", "This page does not query the index again. Use the version and time on each record; historical material does not describe current runtime behavior.")));
  if (index.truncated) box.append(element("p", t("本页目录已截断。未找到的工具可能只是未包含在本页中。", "The index on this page was truncated. A missing tool may simply be absent from this page.")));
}

function rebuild() {
  report = createInventoryReport(entries, index, { selections, generatedAt: new Date().toISOString(), locale: EN ? "en" : "zh" });
  report.demonstration = demonstration;
  renderSummary();
}

function renderSummary() {
  const items = report.items || [];
  const matched = items.filter(item => item.state === "matched").length;
  const attention = items.filter(item => item.state !== "matched" || (item.findings || []).length > 0).length;
  const box = $("report-summary");
  box.replaceChildren();
  for (const [number, text] of [[items.length, t("条清单", " inventory items")], [matched, t("条证据已对应", " evidence matches")], [attention, t("条仍需处理", " require attention")]]) {
    const part = element("p");
    part.append(element("b", number), document.createTextNode(text));
    box.append(part);
  }
}

function selectedKey(item) {
  return selections[item.id] || ((item.candidates || []).find(candidate => item.selected && candidate.server === item.selected.server && candidate.package === item.selected.package && candidate.registry === item.selected.registry && candidate.version === item.selected.version) || {}).key || "";
}

function writeCandidates(select, item) {
  const candidates = item.candidates || [];
  const empty = element("option", candidates.length ? t("请选择或确认对应记录", "Choose or confirm a matching record") : t("没有找到候选记录", "No candidate record found"));
  empty.value = "";
  select.replaceChildren(empty);
  for (const candidate of candidates) {
    const option = element("option", candidate.server + (candidate.package ? " · " + candidate.package : "") + (candidate.version ? " @ " + candidate.version : t(" · 版本未知", " · version unknown")));
    option.value = candidate.key;
    select.append(option);
  }
  const key = selectedKey(item);
  select.value = candidates.some(candidate => candidate.key === key) ? key : "";
  select.disabled = !candidates.length;
}

function writeItemStatus(card, item) {
  const state = card.querySelector(".state");
  state.textContent = item.label || item.state || t("状态未知", "Unknown status");
  state.classList.toggle("attention", item.state !== "matched");
  card.querySelector(".item-reason").textContent = item.reason || "";
  const next = card.querySelector(".item-next");
  next.replaceChildren();
  for (const step of item.nextSteps || []) next.append(element("li", step));
  next.hidden = !next.childElementCount;
  card.querySelector(".version-reference").textContent = item.selected
    ? t("目录记录版本：", "Index record version: ") + (item.selected.version || t("未提供", "not provided")) + t("。不会自动写入实际版本输入框。", ". It will not be copied into the actual-version field.")
    : t("先确认目录记录；实际版本始终由你填写。", "Confirm the index record first. You must always provide the actual version.");
  const select = card.querySelector("select");
  if (select) writeCandidates(select, item);
  const note = card.querySelector(".evidence-note");
  if (note) note.textContent = t("本条目录证据：", "Evidence for this record: ") + (item.evidence || []).length + t(" 个证据块 · 证据生成时间：", " blocks · generated: ") + (item.evidenceGeneratedAt || t("未提供", "not provided")) + t("。来源、检查范围和内容摘要会保留在报告中。", ". Sources, inspection scope, and content digests will remain in the report.");
}

function renderItems() {
  const container = $("inventory-items");
  container.replaceChildren();
  report.items.forEach((item, position) => {
    const entry = entries.find(value => value.id === item.id) || item.input || {};
    const card = element("article", undefined, "item-card");
    card.dataset.entry = item.id;
    const top = element("div", undefined, "item-top");
    const heading = element("div");
    heading.append(element("span", t("工具 ", "Tool ") + (position + 1), "item-number"));
    const title = element("h3", entry.name || entry.server || entry.package || t("未命名工具", "Unnamed tool"));
    title.id = "tool-title-" + position;
    heading.append(title);
    card.setAttribute("aria-labelledby", title.id);
    top.append(heading, element("span", undefined, "state"));
    card.append(top, element("p", undefined, "item-reason"));

    const controls = element("div", undefined, "item-controls");
    const candidates = element("div");
    const selectId = "tool-candidate-" + position;
    const candidateLabel = element("label", t("对应的目录记录", "Matching index record"));
    candidateLabel.htmlFor = selectId;
    const select = element("select");
    select.id = selectId;
    select.dataset.candidateFor = item.id;
    candidates.append(candidateLabel, select);

    const versionArea = element("div");
    const versionId = "tool-version-" + position;
    const versionLabel = element("label", t("你实际使用的版本", "Version you actually use"));
    versionLabel.htmlFor = versionId;
    const version = element("input");
    version.id = versionId;
    version.type = "text";
    version.autocomplete = "off";
    version.spellcheck = false;
    version.placeholder = t("未确认就先留空", "Leave blank until confirmed");
    version.value = entry.version || "";
    version.dataset.versionFor = item.id;
    version.setAttribute("aria-describedby", "version-help-" + position);
    const versionHelp = element("p", t("从你自己的配置或安装记录中确认。", "Confirm it from your own configuration or installation records."), "help");
    versionHelp.id = "version-help-" + position;
    versionArea.append(versionLabel, version, versionHelp);
    controls.append(candidates, versionArea);
    card.append(controls, element("p", undefined, "version-reference"), element("ul", undefined, "item-next"));
    const evidence = item.evidence || [];
    card.append(element("p", t("本条目录证据：", "Evidence for this record: ") + evidence.length + t(" 个证据块。来源、检查范围和内容摘要会保留在导出的报告中。", " blocks. Sources, inspection scope, and content digests will remain in the exported report."), "evidence-note"));
    writeItemStatus(card, item);
    container.append(card);
  });
}

function compareInventory() {
  // A form submission (including Enter) must not cancel the file read by advancing revision.
  if (blockWhileImporting()) return false;
  clearError();
  invalidateInput();
  if (!index) { showError(new Error(t("目录尚不可用，暂时无法核对清单。", "The index is not available, so the inventory cannot be compared yet."))); return false; }
  try {
    if (new TextEncoder().encode(input.value).length > MAX_BYTES) throw new Error(t("清单超过 1 MB，请减少内容后重试。", "The inventory exceeds 1 MB. Reduce it and try again."));
    entries = parseInventory(input.value, { locale: EN ? "en" : "zh" });
    if (!entries.length) throw new Error(t("还没有工具清单。可以先点“直接查看演示报告”，或用“帮我找到清单”了解本机发现方法。", "There is no tool inventory yet. Choose “View demo report” or “Help me find my tools” to get started."));
    rebuild();
    renderItems();
    $("results-section").hidden = false;
    setStatus(t("已核对 ", "Compared ") + entries.length + t(" 条。请确认候选和实际版本；未知项会保留在报告中。", " items. Confirm candidates and actual versions; unknown items will remain in the report."));
    $("results-heading").focus();
    return true;
  } catch (error) { report = null; showError(error); setStatus(t("未生成结果。请按提示调整清单后重试。", "No result was generated. Adjust the inventory as indicated and try again.")); return false; }
}

$("inventory-form").addEventListener("submit", event => {
  event.preventDefault();
  compareInventory();
});

$("discover-button").addEventListener("click", () => {
  $("discovery-guide").open = true;
  $("discovery-summary").focus();
});

input.addEventListener("input", () => {
  clearError();
  invalidateInput();
  fileInput.value = "";
  setStatus(t("清单已修改，请重新核对。旧报告已失效。", "The inventory changed. Compare it again; the previous report is invalid."));
});

fileInput.addEventListener("change", async () => {
  clearError();
  const file = fileInput.files && fileInput.files[0];
  if (!file) {
    if (pendingImport) {
      invalidateInput();
      setStatus(t("文件选择已取消。原清单文本仍保留，可以重新选择文件或直接粘贴。", "File selection was canceled. The previous inventory text was retained; choose another file or paste an inventory."));
    }
    return;
  }
  invalidateInput();
  const thisRevision = revision;
  const operation = { name: file.name };
  setPendingImport(operation);
  setStatus(importingStatus());
  try {
    if (!/\.(txt|json)$/i.test(file.name)) throw new Error(t("请选择 .txt 或 .json 清单文件。", "Choose a .txt or .json inventory file."));
    if (file.size > MAX_BYTES) throw new Error(t("文件超过 1 MB，请选择更小的清单。", "The file exceeds 1 MB. Choose a smaller inventory."));
    let bytes;
    try { bytes = await file.arrayBuffer(); }
    catch { throw new Error(t("无法读取清单文件，请重新选择或直接粘贴清单。", "The inventory file could not be read. Choose it again or paste an inventory.")); }
    if (pendingImport !== operation || thisRevision !== revision) return;
    const options = { locale: EN ? "en" : "zh", format: /\.json$/i.test(file.name) ? "json" : "auto" };
    const text = decodeInventoryFile(bytes, options);
    // Validate before copying anything into the page. A raw application config is not
    // an inventory, even when its encoding or leading fields differ from the examples.
    parseInventory(text, options);
    input.value = text;
    demonstration = false;
    $("demo-note").hidden = true;
    setStatus(t("已在本地读取“", "Read “") + file.name + t("”。点击“核对清单”继续；文件没有上传。", "” locally. Choose “Compare inventory” to continue; the file was not uploaded."));
  } catch (error) {
    if (pendingImport === operation && thisRevision === revision) {
      fileInput.value = "";
      showError(error);
      setStatus(t("文件未导入。原清单文本仍保留，可以重新选择文件，或直接粘贴清单。", "The file was not imported. The previous inventory text was retained; choose another file or paste the inventory."));
    }
  } finally {
    // An obsolete read must not unlock the controls belonging to a newer import.
    if (pendingImport === operation) setPendingImport(null);
  }
});

$("example-button").addEventListener("click", () => {
  clearError();
  if (!index) return;
  // Choosing a different starting path deliberately cancels an in-flight import.
  setPendingImport(null);
  const record = index.records.find(record => record && record.server && Array.isArray(record.packages) && record.packages.some(pkg => pkg && pkg.name));
  const pkg = record && record.packages.find(pkg => pkg && pkg.name);
  input.value = JSON.stringify([
    record ? { name: record.server, ...(pkg.version ? { version: pkg.version } : {}) } : { name: "demo/example-tool", version: "1.0.0" },
    { name: "demo/not-in-this-directory" },
  ], null, 2);
  demonstration = true;
  $("demo-note").hidden = false;
  fileInput.value = "";
  if (compareInventory()) previewReport();
});

$("reset-button").addEventListener("click", () => {
  clearError();
  invalidateInput();
  input.value = "";
  fileInput.value = "";
  demonstration = false;
  $("demo-note").hidden = true;
  setStatus(t("清单和报告已从页面内存中清除。已下载的文件由你自行保留或删除。", "The inventory and report were cleared from page memory. You control any files already downloaded."));
  input.focus();
});

$("inventory-items").addEventListener("change", event => {
  const id = event.target.dataset.candidateFor;
  if (!id) return;
  clearError();
  invalidatePreview();
  selections[id] = event.target.value;
  try {
    rebuild();
    const oldId = event.target.id;
    renderItems();
    $(oldId)?.focus();
    setStatus(t("对应记录已调整。请重新生成预览后下载。", "The matching record changed. Generate a new preview before downloading."));
  } catch (error) { showError(error); }
});

$("inventory-items").addEventListener("input", event => {
  const id = event.target.dataset.versionFor;
  if (!id) return;
  clearError();
  invalidatePreview();
  const entry = entries.find(value => value.id === id);
  if (entry) entry.version = event.target.value.trim();
  try {
    rebuild();
    // A version edit can make another row a duplicate (or resolve a duplicate).
    // Refresh all verdicts without replacing inputs, preserving typing focus.
    for (const item of report.items) {
      const card = $("inventory-items").querySelector('[data-entry="' + item.id + '"]');
      if (card) writeItemStatus(card, item);
    }
    setStatus(t("实际版本已修改。请重新生成预览后下载。", "The actual version changed. Generate a new preview before downloading."));
  } catch (error) { report = null; showError(error); }
});

function previewReport() {
  if (blockWhileImporting()) return;
  clearError();
  invalidatePreview();
  try {
    if (!entries.length) throw new Error(t("请先核对一份清单。", "Compare an inventory first."));
    rebuild();
    reportHtml = renderInventoryReport(report);
    $("report-preview").srcdoc = reportHtml;
    $("preview-section").hidden = false;
    $("download-button").disabled = false;
    $("preview-status").textContent = (demonstration ? t("演示报告 · ", "Demonstration report · ") : "") + t("本地生成于 ", "Generated locally at ") + report.generatedAt + t("；后续修改会使这份预览与下载失效。", ". Later changes will invalidate this preview and download.");
    $("preview-heading").focus();
    setStatus(t("报告已在本地生成。请先查看未覆盖项，再决定是否下载与分享。", "The report was generated locally. Review uncovered items before downloading or sharing it."));
  } catch (error) { reportHtml = null; showError(error); }
}

$("preview-button").addEventListener("click", previewReport);

$("download-button").addEventListener("click", () => {
  if (!reportHtml || !report) return;
  if (downloadUrl) URL.revokeObjectURL(downloadUrl);
  downloadUrl = URL.createObjectURL(new Blob([reportHtml], { type: "text/html;charset=utf-8" }));
  const link = element("a");
  link.href = downloadUrl;
  link.download = "agentgate-inventory-" + (demonstration ? "demo-" : "") + new Date().toISOString().slice(0, 10) + ".html";
  document.body.append(link);
  link.click();
  link.remove();
  setStatus(t("已准备下载。报告包含你填写的名称和版本，请在分享前审阅。", "The download is ready. Review the names and versions you entered before sharing the report."));
});

try {
  index = JSON.parse($("inventory-index").textContent);
  if (!index || !Array.isArray(index.records)) throw new Error(t("页面没有可用的证据目录，请使用构建后的页面或本地服务。", "This page has no usable evidence index. Use the built page or local service."));
  indexDescription();
  $("compare-button").disabled = false;
  $("example-button").disabled = false;
  setStatus(t("清单会在此页面内处理。可以先用演示清单了解流程。", "The inventory will be processed in this page. Use the demonstration to explore the workflow."));
} catch (error) {
  index = null;
  $("index-status").textContent = t("目录不可用；没有进行任何核对。", "The index is unavailable; no comparison was performed.");
  showError(new Error(t("无法读取页面中的证据目录。请使用构建后的页面或本地服务，原始模板不能直接核对清单。", "The evidence index could not be read. Use the built page or local service; the raw template cannot compare inventories.")));
  setStatus(t("请先确认页面已带上证据目录。", "Confirm that the page contains an evidence index."));
}
