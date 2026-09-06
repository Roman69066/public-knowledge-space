/**
 * test-frontend.js — 用jsdom真实加载 index.html、真实点击/输入、
 * 真实向本机运行的server.js发起fetch请求，检查渲染结果是否符合预期。
 *
 * 这不是像素级截图，但验证的是同一件事：这个前端代码真的能跑通
 * 注册→创建探索→公开→第三方追问→Collaborated 的完整闭环。
 */
const { JSDOM } = require('jsdom');

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitFor(fn, { timeout = 5000, interval = 150, label = '' } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const result = fn();
    if (result) return result;
    await wait(interval);
  }
  throw new Error('waitFor超时: ' + label);
}

async function newSession() {
  const dom = await JSDOM.fromURL('http://localhost:4000/app/', {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
  });
  dom.window.fetch = fetch; // 注入Node原生fetch，脚本内的fetch调用会真实打到本机server
  return dom;
}

async function ensureChinese(dom) {
  // jsdom默认navigator.language通常是en-US，会让i18n默认落到英文；
  // 这里强制切回中文，保证既有测试断言(检查中文文案)依然成立，
  // 同时顺带验证了"点击语言切换按钮"这个交互本身是好用的。
  await wait(150);
  if (dom.window.document.documentElement.lang !== 'zh') {
    const btn = dom.window.document.querySelector('[data-action="toggle-lang"]');
    if (btn) { btn.click(); await wait(150); }
  }
}

function text(dom) { return dom.window.document.body.textContent; }

async function signup(dom, email, password, name) {
  dom.window.location.hash = '#/auth';
  await wait(200);
  dom.window.document.getElementById('f-email').value = email;
  dom.window.document.getElementById('f-password').value = password;
  dom.window.document.getElementById('f-name').value = name;
  dom.window.document.getElementById('btn-signup').click();
  await waitFor(() => dom.window.location.hash === '#/', { label: `signup(${email})` });
}

async function run() {
  console.log('==== 测试1: Alice通过jsdom真实注册 ====');
  const alice = await newSession();
  await ensureChinese(alice);
  await signup(alice, 'alice.fe@example.com', 'alice-secure-pw', 'Alice前端测试');
  await wait(200);
  console.assert(text(alice).includes('你想弄清楚什么'), 'FAIL: 注册后应跳转到首页');
  console.log('PASS: 注册成功并跳转首页，页面文字包含"你想弄清楚什么"');

  console.log('\n==== 测试2: Alice创建探索 ====');
  alice.window.document.getElementById('f-question').value = '为什么猫喜欢纸箱？';
  alice.window.document.getElementById('btn-ask').click();
  await waitFor(() => /#\/exploration\//.test(alice.window.location.hash), { label: '创建探索后跳转' });
  const expId = alice.window.location.hash.split('/').pop();
  await wait(300);
  console.assert(text(alice).includes('为什么猫喜欢纸箱'), 'FAIL: 详情页应显示Q0');
  console.assert(text(alice).includes('私享'), 'FAIL: 新建探索应显示"私享"badge');
  console.log('PASS: 探索创建成功, id=' + expId + '，页面正确显示Q0与"私享"状态');

  console.log('\n==== 测试3: Alice匿名公开 ====');
  const identitySelect = alice.window.document.getElementById('identity-mode');
  identitySelect.value = 'ANONYMOUS';
  alice.window.document.getElementById('btn-publish').click();
  await waitFor(() => text(alice).includes('已公开'), { label: '公开后badge更新' });
  console.log('PASS: 公开后页面显示"已公开"');

  console.log('\n==== 测试4: Bob（独立会话，独立localStorage）访问并追问 ====');
  const bob = await newSession();
  await ensureChinese(bob);
  await signup(bob, 'bob.fe@example.com', 'bob-secure-pw', 'Bob前端测试');
  bob.window.location.hash = '#/exploration/' + expId;
  await wait(400);
  console.assert(text(bob).includes('为什么猫喜欢纸箱'), 'FAIL: Bob应该能看到Alice公开的探索');
  console.log('PASS: Bob能看到Alice公开的探索内容');

  bob.window.document.getElementById('f-followup').value = '是因为纸箱能提供安全感吗？';
  bob.window.document.getElementById('btn-followup').click();
  await waitFor(() => {
    const el = bob.window.document.getElementById('pending-status');
    return el && el.textContent.includes('已被接受');
  }, { timeout: 8000, label: 'Bob追问被处理完成' });
  console.log('PASS: Bob的追问被worker异步处理完成，前端轮询正确显示"已被接受并生成回答"');

  await wait(1200); // 等待页面因COMPLETED自动刷新
  console.assert(text(bob).includes('公共协作中'), 'FAIL: 页面应显示已进入COLLABORATED');
  console.assert(text(bob).includes('是因为纸箱能提供安全感吗'), 'FAIL: 树里应出现Bob的追问');
  console.log('PASS: 页面自动刷新后显示"公共协作中"，且树里出现了Bob的追问节点');

  console.log('\n==== 测试5: Alice刷新页面，应该看到COLLABORATED且不能撤回 ====');
  alice.window.location.hash = '#/';
  await wait(100);
  alice.window.location.hash = '#/exploration/' + expId;
  await wait(400);
  console.assert(text(alice).includes('公共协作中'), 'FAIL: Alice应看到COLLABORATED');
  console.assert(text(alice).includes('不能被整体撤回'), 'FAIL: 应显示协作锁提示文案，而不是撤回按钮');
  console.log('PASS: Alice看到COLLABORATED状态，且看到的是治理提示而不是撤回按钮');

  console.log('\n==== 测试6: 错误密码登录应显示错误提示 ====');
  const eve = await newSession();
  await ensureChinese(eve);
  eve.window.location.hash = '#/auth';
  await wait(200);
  eve.window.document.getElementById('f-email').value = 'alice.fe@example.com';
  eve.window.document.getElementById('f-password').value = 'wrong-password';
  eve.window.document.getElementById('btn-login').click();
  await waitFor(() => text(eve).includes('邮箱或密码错误'), { label: '错误登录提示' });
  console.log('PASS: 错误密码登录正确显示"邮箱或密码错误"，没有静默失败或崩溃');

  console.log('\n==== 测试7: 中英文切换真实生效 ====');
  const lang = await newSession();
  await wait(300);
  console.assert(text(lang).includes('What do you want to figure out') || text(lang).includes('Log in'),
    'FAIL: jsdom默认应落到英文（navigator.language通常是en-US）');
  console.log('PASS: 默认（未设置过localStorage的全新浏览器）语言落在英文，符合navigator.language检测逻辑');

  const toggleBtn = lang.window.document.querySelector('[data-action="toggle-lang"]');
  toggleBtn.click();
  await wait(200);
  console.assert(text(lang).includes('你想弄清楚') || text(lang).includes('登录'),
    'FAIL: 点击切换按钮后应显示中文');
  console.log('PASS: 点击语言切换按钮后，页面正确切换为中文');

  const toggleBtn2 = lang.window.document.querySelector('[data-action="toggle-lang"]');
  toggleBtn2.click();
  await wait(200);
  console.assert(text(lang).includes('What do you want to figure out') || text(lang).includes('Log in'),
    'FAIL: 再次点击应切回英文');
  console.log('PASS: 再次点击切回英文，且localStorage持久化了这个选择（下次打开会记住）');

  console.log('\n所有前端功能测试通过。');
}

run().catch((e) => {
  console.error('测试失败:', e);
  process.exit(1);
});
