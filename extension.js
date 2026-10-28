'use strict';

const vscode = require('vscode');

const LS_EXT = 'google.google-antigravity';
const LS_SVC = '/exa.language_server_pb.LanguageServerService/';

const TASK_AUTO = '你需要充分阅读和理解本次代码变更内容，然后基于下面给出的提交历史记录，输出一条相同风格的代码提交信息。如果变更涉及多处改动或比较复杂，应当在首行之后用空行分隔，附上详细的 body 说明各项变更。';

let channel;
function output() {
  if (!channel) channel = vscode.window.createOutputChannel('AGY Commit');
  return channel;
}
function log() {
  output().appendLine(Array.prototype.map.call(arguments, String).join(' '));
}

function config() {
  return vscode.workspace.getConfiguration('agyCommit');
}

async function gitApi() {
  const ext = vscode.extensions.getExtension('vscode.git');
  if (!ext) throw new Error('找不到内置 git 扩展');
  const git = ext.isActive ? ext.exports : await ext.activate();
  return git.getAPI(1);
}

async function getRepo() {
  const repos = (await gitApi()).repositories || [];
  if (!repos.length) throw new Error('当前工作区没有 git 仓库');
  const active = vscode.window.activeTextEditor;
  if (active) {
    const p = active.document.uri.fsPath;
    const hit = repos.find((r) => p && p.startsWith(r.rootUri.fsPath));
    if (hit) return hit;
  }
  return repos[0];
}

function stagedPaths(repo) {
  const changes = (repo.state && repo.state.indexChanges) || [];
  const seen = new Set();
  const out = [];
  for (const c of changes) {
    const p = c && c.uri && c.uri.fsPath;
    if (!p || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

async function readStagedDiff(repo, paths) {
  const parts = await Promise.all(paths.map(async (p) => {
    try {
      return await repo.diffIndexWithHEAD(p);
    } catch (e) {
      log('读取改动失败：' + p + '：' + (e && e.message));
      return '';
    }
  }));
  return parts.filter(Boolean).join('');
}

async function recentMessages(repo, n) {
  try {
    const commits = await repo.log({ maxEntries: n });
    return (commits || []).map((c) => String(c.message || '').split('\n')[0]).join('\n');
  } catch (e) {
    log('读取提交历史失败：' + (e && e.message));
    return '';
  }
}

function trimDiff(diff, max) {
  max = max || 120000;
  if (diff.length <= max) return diff;
  return diff.slice(0, max) + '\n... (diff 已截断，原始长度 ' + diff.length + ' 字符)';
}

function instruction(language) {
  return ['你是一位经验丰富的程序员，你的任务是根据代码变更，输出一条代码提交信息。',
    TASK_AUTO,
    ['其他要求：', '1. 输出结果的返回语言是 ' + language, '2. 输出结果仅包含提交信息，不允许包含其他内容', '3. subject 与 body 之间必须有一个空行分隔'].join('\n')].join('\n\n');
}

async function buildPrompt(repo, diff, files) {
  const c = config();
  const language = c.get('commitMessageLanguage', 'zh_CN') === 'en' ? 'English' : '简体中文';
  const parts = [instruction(language)];
  const history = await recentMessages(repo, 10);
  if (history) parts.push('之前的提交历史记录供你参考（只用于模仿风格，不要照抄内容）：\n' + history);
  parts.push('本次代码变更文件名：\n' + (files || '(未知)'));
  parts.push('本次代码变更内容：\n```diff\n' + trimDiff(diff) + '\n```');
  return parts.join('\n\n');
}

async function lsEndpoint() {
  const ext = vscode.extensions.getExtension(LS_EXT);
  if (!ext) throw new Error('找不到 Antigravity 扩展（' + LS_EXT + '）');
  const api = ext.isActive ? ext.exports : await ext.activate();
  if (!api || !api.port || !api.csrfToken) throw new Error('未能从 Antigravity 扩展取得端口 / CSRF token');
  return { base: 'http://127.0.0.1:' + api.port + LS_SVC, token: api.csrfToken };
}

async function lsRpc(method, body) {
  const ep = await lsEndpoint();
  const r = await fetch(ep.base + method, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Connect-Protocol-Version': '1',
      'x-codeium-csrf-token': ep.token
    },
    body: JSON.stringify(body)
  });
  const raw = await r.text();
  let j;
  try {
    j = JSON.parse(raw);
  } catch (e) {
    throw new Error('Antigravity 返回无法解析：' + raw.slice(0, 200));
  }
  if (j.code) throw new Error('Antigravity 返回错误：' + (j.message || j.code));
  return j;
}

async function officialCommitModel() {
  const res = await lsRpc('GetAvailableModels', {});
  const info = res.response || {};
  const id = (info.commitMessageModelIds || [])[0];
  if (!id) throw new Error('未取到官方提交模型');
  const enumName = info.models && info.models[id] && info.models[id].model;
  if (!enumName) throw new Error('未取到官方提交模型枚举');
  return enumName;
}

function clean(text) {
  let t = (text || '').trim();
  t = t.replace(/^```[a-zA-Z]*\s*\n?/, '').replace(/\n?```\s*$/, '');
  t = t.replace(/^["'\u300c\u300e]+/, '').replace(/["'\u300d\u300f]+$/, '');
  return t.trim();
}

async function generate(repo) {
  const paths = stagedPaths(repo);
  const state = repo.state || {};
  if (!paths.length) {
    const others = (state.workingTreeChanges || []).length + (state.untrackedChanges || []).length;
    if (others) throw notice('没有暂存的更改，请先暂存要提交的文件');
    throw notice('没有可提交的更改');
  }
  const diff = await readStagedDiff(repo, paths);
  if (!diff) throw notice('没有可提交的更改');
  const prompt = await buildPrompt(repo, diff, paths.join('\n'));
  const model = await officialCommitModel();
  const res = await lsRpc('GetModelResponse', { prompt: prompt, model: model });
  const msg = clean(res.response);
  if (!msg) throw new Error('生成结果为空');
  repo.inputBox.value = msg;
}

function notice(text) {
  const e = new Error(text);
  e.notice = true;
  return e;
}

function flag(name, value) {
  return vscode.commands.executeCommand('setContext', 'agyCommit.' + name, value);
}

async function runGenerate() {
  try {
    await flag('busy', true);
    await generate(await getRepo());
    await flag('busy', false);
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    if (e && e.notice) {
      await flag('busy', false);
      vscode.window.showInformationMessage(msg);
      return;
    }
    log('ERROR: ' + msg);
    const pick = await vscode.window.showErrorMessage('生成提交信息失败：' + msg, '查看日志');
    if (pick === '查看日志') output().show();
    await flag('busy', false);
  }
}

function activate(context) {
  context.subscriptions.push(vscode.commands.registerCommand('agyCommit.generate', () => runGenerate()));
  context.subscriptions.push(vscode.commands.registerCommand('agyCommit.busy', () => {}));
  context.subscriptions.push(output());
}

function deactivate() {}

module.exports = { activate: activate, deactivate: deactivate };
