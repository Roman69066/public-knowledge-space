/**
 * lib/llm-client.js — 对Anthropic Messages API的最小封装
 *
 * 用Node 22原生fetch，不需要额外SDK依赖。
 * API key只从环境变量ANTHROPIC_API_KEY读取，代码里任何地方都不会
 * 硬编码或接受通过HTTP请求体/参数传入的key——这不是随手加的限制，
 * 是因为key一旦出现在请求体或日志里就有被意外记录/转发的风险。
 */

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-sonnet-5'; // 可用 ANTHROPIC_MODEL 环境变量覆盖

function hasApiKey() {
  return !!process.env.ANTHROPIC_API_KEY;
}

async function callClaude({ system, messages, maxTokens = 1024 }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY未设置');
  }
  const model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;

  const res = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Anthropic API错误 ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  const textBlock = (data.content || []).find((b) => b.type === 'text');
  if (!textBlock) throw new Error('响应中没有text内容块');
  return textBlock.text;
}

module.exports = { callClaude, hasApiKey, DEFAULT_MODEL };
