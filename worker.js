export default {
    async fetch(request, env) {
      const url = new URL(request.url);
  
      // ==========================================
      // 1. API: 翻译服务 (增加 CORS 头，虽然同源非必须但好习惯)
      // ==========================================
      if (url.pathname === '/api/translate' && request.method === 'POST') {
        try {
          const { text, source_lang, target_lang } = await request.json();
          
          if (!text) return new Response(JSON.stringify({ error: '内容不能为空' }), { status: 400 });
          if (!env.AI) return new Response(JSON.stringify({ error: '未绑定 AI 变量' }), { status: 500 });
  
          // 构建提示词 (Prompt Engineering)
          const systemPrompt = `You are a professional translator. Translate the following text from ${source_lang || 'English'} to ${target_lang || 'Chinese'}. Do not include any explanations, notes, or extra text. Only output the translation.`;
  
          // 调用 Llama 3 模型 (比 m2m100 更智能)
          const response = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: text }
            ]
          });
  
          // Llama 3 返回的字段通常是 response，但前端需要 translated_text
          // 我们在这里做一下转换，保持前端代码不用动
          const result = {
              translated_text: response.response.trim()
          };
  
          return new Response(JSON.stringify(result), { 
            headers: { 
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*' 
            } 
          });
        } catch (err) {
          return new Response(JSON.stringify({ error: err.message }), { status: 500 });
        }
      }
  
      // ==========================================
      // 2. PWA 配置 (Manifest)
      // ==========================================
      if (url.pathname === '/manifest.json') {
        const manifest = {
          name: "AI 随身翻译",
          short_name: "AI 翻译",
          start_url: "/",
          display: "standalone",
          background_color: "#ffffff",
          theme_color: "#4f46e5",
          orientation: "portrait-primary",
          icons: [
            { src: "/icon.png", sizes: "192x192", type: "image/png" },
            { src: "/icon.png", sizes: "512x512", type: "image/png" }
          ]
        };
        return new Response(JSON.stringify(manifest), { headers: { 'Content-Type': 'application/json' } });
      }
  
      // ==========================================
      // 3. PWA Service Worker (缓存策略)
      // ==========================================
      if (url.pathname === '/sw.js') {
        const swCode = `
          const CACHE_NAME = 'ai-trans-v-final';
          const FILES_TO_CACHE = ['/', '/icon.png', '/manifest.json'];
          
          self.addEventListener('install', (e) => {
            e.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(FILES_TO_CACHE)));
          });
          
          self.addEventListener('fetch', (e) => {
            // 优先网络，失败则读取缓存 (Network First)
            e.respondWith(
              fetch(e.request).catch(() => caches.match(e.request))
            );
          });
        `;
        return new Response(swCode, { headers: { 'Content-Type': 'application/javascript' } });
      }
  
      // ==========================================
      // 4. 动态图标 (SVG)
      // ==========================================
      if (url.pathname === '/icon.png') {
        const svg = `
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
            <defs>
               <linearGradient id="grad1" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" style="stop-color:#4f46e5;stop-opacity:1" />
                <stop offset="100%" style="stop-color:#06b6d4;stop-opacity:1" />
              </linearGradient>
            </defs>
            <rect width="512" height="512" rx="128" fill="url(#grad1)" />
            <path d="M140 256 L372 256 M256 140 L256 372" stroke="white" stroke-width="40" stroke-linecap="round" />
            <text x="50%" y="54%" dominant-baseline="middle" text-anchor="middle" font-family="sans-serif" font-weight="900" font-size="220" fill="white">AI</text>
          </svg>
        `;
        return new Response(svg, { headers: { 'Content-Type': 'image/svg+xml' } });
      }
  
      // ==========================================
      // 5. 最终版前端 UI
      // ==========================================
      return new Response(html, {
        headers: { 'Content-Type': 'text/html;charset=UTF-8' },
      });
    }
  };
  
  const html = `
  <!DOCTYPE html>
  <html lang="zh-CN" class="">
  <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
      <title>AI 随身翻译</title>
      
      <link rel="manifest" href="/manifest.json">
      <link rel="icon" href="/icon.png" type="image/svg+xml">
      <meta name="theme-color" content="#ffffff">
      <meta name="apple-mobile-web-app-capable" content="yes">
      
      <script src="https://cdn.tailwindcss.com"></script>
      <script>
          tailwind.config = {
              darkMode: 'class', // 启用手动深色模式
          }
      </script>
      <link href="https://cdn.jsdelivr.net/npm/remixicon@3.5.0/fonts/remixicon.css" rel="stylesheet">
      <script src='https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js'></script>
      
      <style>
          @import url('https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400;500;700&display=swap');
          
          body { 
              font-family: 'Noto Sans SC', sans-serif; 
              transition: background-color 0.3s, color 0.3s;
          }
  
          /* 浅色背景渐变 */
          .bg-light { background: linear-gradient(135deg, #fdfbfb 0%, #ebedee 100%); }
          /* 深色背景渐变 */
          .bg-dark { background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%); }
  
          /* 卡片样式：玻璃拟态 */
          .glass-card {
              background: rgba(255, 255, 255, 0.85);
              backdrop-filter: blur(12px);
              transition: all 0.3s ease;
          }
          .dark .glass-card {
              background: rgba(30, 41, 59, 0.7); /* 深色模式下的玻璃 */
              border: 1px solid rgba(255,255,255,0.05);
          }
  
          textarea { resize: none; overflow: hidden; min-height: 120px; }
          textarea:focus { outline: none; }
          * { -webkit-tap-highlight-color: transparent; }
  
          .spinner { width: 18px; height: 18px; border: 2px solid currentColor; border-bottom-color: transparent; border-radius: 50%; animation: rotation 1s linear infinite; }
          @keyframes rotation { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
  
          /* 朗读波纹 */
          .speaking { animation: pulse 1s infinite; color: #6366f1; }
          @keyframes pulse { 0% { transform: scale(1); opacity: 1; } 50% { transform: scale(1.2); opacity: 0.8; } 100% { transform: scale(1); opacity: 1; } }
  
          /* 历史记录侧边栏动画 */
          .slide-enter { transform: translateX(100%); }
          .slide-active { transform: translateX(0); }
      </style>
  </head>
  <body class="bg-light min-h-screen text-slate-800 dark:text-slate-100 flex justify-center">
  
      <div class="w-full max-w-4xl min-h-screen md:min-h-[800px] md:my-10 md:rounded-3xl glass-card flex flex-col shadow-2xl relative overflow-hidden">
          
          <header class="sticky top-0 z-40 bg-white/80 dark:bg-slate-900/80 backdrop-blur-md px-5 py-4 border-b border-slate-200 dark:border-slate-700 flex justify-between items-center pt-safe-top">
              <div class="flex items-center gap-3">
                  <div class="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center text-white shadow-md">
                      <i class="ri-translate-2 text-lg"></i>
                  </div>
                  <h1 class="font-bold text-lg tracking-wide">AI 翻译</h1>
              </div>
              
              <div class="flex gap-1">
                  <button onclick="toggleHistory()" class="p-2 rounded-full hover:bg-slate-100 dark:hover:bg-slate-800 transition text-slate-500 dark:text-slate-400" title="历史记录">
                      <i class="ri-history-line text-xl"></i>
                  </button>
                  <button onclick="toggleDarkMode()" class="p-2 rounded-full hover:bg-slate-100 dark:hover:bg-slate-800 transition text-slate-500 dark:text-slate-400" title="切换主题">
                      <i id="themeIcon" class="ri-moon-line text-xl"></i>
                  </button>
              </div>
          </header>
  
          <main class="flex flex-col md:flex-row flex-1">
              
              <section class="flex-1 flex flex-col border-b md:border-b-0 md:border-r border-slate-200 dark:border-slate-700 relative">
                  <div class="sticky top-[72px] md:top-0 z-30 px-5 py-3 flex justify-between items-center bg-white/50 dark:bg-slate-800/50 backdrop-blur-sm">
                      <div class="flex items-center gap-2">
                      <select id="sourceLang" class="appearance-none bg-transparent font-bold text-slate-700 dark:text-slate-200 py-1 pr-1 cursor-pointer outline-none">
                              <option value="english">英语</option>
                              <option value="chinese">中文</option>
                              <option value="japanese">日语</option>
                              <option value="korean">韩语</option>
                              <option value="french">法语</option>
                              <option value="german">德语</option>
                              <option value="spanish">西语</option>
                              <option value="russian">俄语</option>
                          </select>
                          <i class="ri-arrow-down-s-line text-slate-400"></i>
                          <button onclick="swapLanguages()" class="ml-2 p-1.5 rounded-md hover:bg-slate-200 dark:hover:bg-slate-700 text-indigo-500 transition">
                              <i class="ri-arrow-left-right-line"></i>
                          </button>
                      </div>
                      
                      <div class="flex gap-2">
                           <button onclick="speak('source')" id="btnSpeakSource" class="p-2 text-slate-400 hover:text-indigo-600 transition"><i class="ri-volume-up-line text-lg"></i></button>
                           <button onclick="openCamera()" class="p-2 text-slate-400 hover:text-indigo-600 transition"><i class="ri-camera-line text-lg"></i></button>
                           <button onclick="clearText()" class="p-2 text-slate-400 hover:text-red-500 transition"><i class="ri-delete-bin-line text-lg"></i></button>
                      </div>
                  </div>
  
                  <div class="flex-1 p-5">
                      <textarea id="inputText" class="w-full bg-transparent text-xl leading-relaxed placeholder-slate-400 dark:placeholder-slate-600 text-slate-800 dark:text-slate-100" 
                      placeholder="输入文字或拍照..." oninput="autoResize(this)"></textarea>
                  </div>
  
                  <div class="px-5 py-4 flex justify-between items-center bg-white/30 dark:bg-slate-800/30">
                      <span id="charCount" class="text-xs text-slate-400">0 字</span>
                      <button id="translateBtn" onclick="doTranslate()" class="bg-indigo-600 hover:bg-indigo-700 text-white px-6 py-2.5 rounded-xl shadow-lg shadow-indigo-500/30 transition-transform active:scale-95 flex items-center gap-2 font-medium">
                          <span id="btnText">翻译</span>
                          <span id="loader" class="spinner hidden"></span>
                      </button>
                  </div>
              </section>
  
              <section class="flex-1 flex flex-col bg-slate-50/50 dark:bg-slate-900/50 min-h-[300px]">
                  <div class="sticky top-[72px] md:top-0 z-30 px-5 py-3 flex justify-between items-center bg-slate-50/80 dark:bg-slate-900/80 backdrop-blur-sm">
                      <div class="flex items-center gap-2">
                      <select id="targetLang" class="appearance-none bg-transparent font-bold text-indigo-600 dark:text-indigo-400 py-1 pr-1 cursor-pointer outline-none">
                              <option value="chinese" selected>中文</option>
                              <option value="english">英语</option>
                              <option value="japanese">日语</option>
                              <option value="korean">韩语</option>
                              <option value="french">法语</option>
                              <option value="german">德语</option>
                              <option value="spanish">西语</option>
                              <option value="russian">俄语</option>
                          </select>
                          <i class="ri-arrow-down-s-line text-indigo-300"></i>
                      </div>
                      <div class="flex gap-2">
                          <button onclick="speak('target')" id="btnSpeakTarget" class="p-2 text-slate-400 hover:text-indigo-600 transition"><i class="ri-volume-up-line text-lg"></i></button>
                          <button onclick="copyResult()" class="p-2 text-slate-400 hover:text-indigo-600 transition"><i class="ri-file-copy-line text-lg"></i></button>
                      </div>
                  </div>
                  
                  <div id="outputText" class="flex-1 w-full px-5 py-4 text-xl leading-relaxed text-indigo-900 dark:text-indigo-100 whitespace-pre-wrap pb-20 select-text"></div>
              </section>
          </main>
  
      </div>
  
      <div id="historyPanel" class="fixed inset-y-0 right-0 w-80 bg-white dark:bg-slate-800 shadow-2xl transform translate-x-full transition-transform duration-300 z-50 flex flex-col">
          <div class="p-4 border-b border-slate-100 dark:border-slate-700 flex justify-between items-center">
              <h2 class="font-bold text-lg dark:text-white">历史记录</h2>
              <button onclick="toggleHistory()" class="text-slate-400 hover:text-red-500"><i class="ri-close-line text-2xl"></i></button>
          </div>
          <div id="historyList" class="flex-1 overflow-y-auto p-2 space-y-2">
              <div class="text-center text-slate-400 mt-10 text-sm">暂无历史记录</div>
          </div>
          <div class="p-4 border-t border-slate-100 dark:border-slate-700">
              <button onclick="clearHistory()" class="w-full py-2 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg text-sm transition">清空记录</button>
          </div>
      </div>
      <div id="historyBackdrop" onclick="toggleHistory()" class="fixed inset-0 bg-black/20 backdrop-blur-sm z-40 hidden transition-opacity"></div>
  
      <div id="toast" class="fixed top-6 left-1/2 transform -translate-x-1/2 px-4 py-2 bg-slate-800 dark:bg-white text-white dark:text-slate-900 rounded-full shadow-lg opacity-0 transition-all duration-300 pointer-events-none z-[60] flex items-center gap-2 text-sm font-medium">
          <i class="ri-information-line"></i> <span id="toastMsg">提示信息</span>
      </div>
  
      <div id="cameraModal" class="fixed inset-0 bg-black z-[100] hidden flex-col">
          <div class="relative flex-1 bg-black overflow-hidden">
              <video id="cameraVideo" autoplay playsinline class="w-full h-full object-cover"></video>
              <div class="absolute top-0 left-0 w-full h-1 bg-indigo-500 shadow-[0_0_15px_rgba(99,102,241,0.8)] animate-[scan_2.5s_linear_infinite]"></div>
              <div id="ocrStatus" class="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 text-white bg-black/60 px-4 py-2 rounded-lg hidden">正在识别文字...</div>
          </div>
          <div class="h-32 bg-black flex items-center justify-between px-10 pb-safe-bottom">
              <button onclick="closeCamera()" class="text-white opacity-80"><i class="ri-close-circle-line text-4xl"></i></button>
              <button onclick="captureAndRecognize()" class="w-16 h-16 rounded-full border-4 border-white bg-white/20 flex items-center justify-center active:scale-95 transition"><div class="w-12 h-12 bg-white rounded-full"></div></button>
              <div class="w-9"></div>
          </div>
      </div>
      <canvas id="canvas" class="hidden"></canvas>
  
      <script>
          if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');
  
          // Elements
          const els = {
              input: document.getElementById('inputText'),
              output: document.getElementById('outputText'),
              source: document.getElementById('sourceLang'),
              target: document.getElementById('targetLang'),
              loader: document.getElementById('loader'),
              btnText: document.getElementById('btnText'),
              translateBtn: document.getElementById('translateBtn'),
              charCount: document.getElementById('charCount')
          };
  
          // --- 1. 深色模式 (Dark Mode) ---
          function initTheme() {
              if (localStorage.theme === 'dark' || (!('theme' in localStorage) && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
                  document.documentElement.classList.add('dark');
                  document.body.classList.replace('bg-light', 'bg-dark');
                  document.getElementById('themeIcon').classList.replace('ri-moon-line', 'ri-sun-line');
              } else {
                  document.documentElement.classList.remove('dark');
                  document.body.classList.replace('bg-dark', 'bg-light');
                  document.getElementById('themeIcon').classList.replace('ri-sun-line', 'ri-moon-line');
              }
          }
          function toggleDarkMode() {
              if (document.documentElement.classList.contains('dark')) {
                  localStorage.theme = 'light';
              } else {
                  localStorage.theme = 'dark';
              }
              initTheme();
          }
          initTheme();
  
          // --- 2. 交互反馈 (Toast) ---
          function showToast(msg, type = 'info') {
              const toast = document.getElementById('toast');
              document.getElementById('toastMsg').innerText = msg;
              toast.classList.remove('opacity-0', 'translate-y-4');
              setTimeout(() => toast.classList.add('opacity-0', 'translate-y-4'), 2500);
          }
  
          // --- 3. 翻译核心逻辑 ---
          function autoResize(el) {
              el.style.height = 'auto';
              el.style.height = el.scrollHeight + 'px';
          }
          
          els.input.addEventListener('input', () => {
              autoResize(els.input);
              els.charCount.innerText = els.input.value.length + ' 字';
              debounceTranslate();
          });
  
          let debounceTimer;
          function debounceTranslate() {
              clearTimeout(debounceTimer);
              if (!els.input.value.trim()) { els.output.innerText = ''; return; }
              debounceTimer = setTimeout(doTranslate, 1000);
          }
  
          async function doTranslate() {
              const text = els.input.value.trim();
              if (!text) return;
  
              els.translateBtn.disabled = true;
              els.btnText.innerText = "翻译中...";
              els.loader.classList.remove('hidden');
              els.output.style.opacity = '0.5';
  
              try {
                  const res = await fetch('/api/translate', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ text, source_lang: els.source.value, target_lang: els.target.value })
                  });
                  const data = await res.json();
                  
                  if (data.translated_text) {
                      els.output.innerText = data.translated_text;
                      saveToHistory(text, data.translated_text); // 保存历史
                  } else {
                      showToast("翻译失败: " + (data.error || "未知错误"));
                  }
              } catch (e) {
                  showToast("网络连接失败，请检查网络");
              } finally {
                  els.translateBtn.disabled = false;
                  els.btnText.innerText = "翻译";
                  els.loader.classList.add('hidden');
                  els.output.style.opacity = '1';
              }
          }
  
          // --- 4. 历史记录系统 ---
          function saveToHistory(src, dst) {
              let history = JSON.parse(localStorage.getItem('trans_history') || '[]');
              // 避免重复保存最新的一条
              if (history.length > 0 && history[0].src === src && history[0].dst === dst) return;
              
              history.unshift({ src, dst, time: new Date().toLocaleTimeString() });
              if (history.length > 20) history.pop(); // 只存20条
              localStorage.setItem('trans_history', JSON.stringify(history));
              renderHistory();
          }
  
          function renderHistory() {
              const list = document.getElementById('historyList');
              const history = JSON.parse(localStorage.getItem('trans_history') || '[]');
              
              if (history.length === 0) {
                  list.innerHTML = '<div class="text-center text-slate-400 mt-10 text-sm">暂无历史记录</div>';
                  return;
              }
  
              list.innerHTML = history.map((item, index) => \`
                  <div onclick="restoreHistory(\${index})" class="p-3 bg-slate-50 dark:bg-slate-700/50 rounded-lg hover:bg-indigo-50 dark:hover:bg-indigo-900/30 cursor-pointer transition border border-transparent hover:border-indigo-200 group">
                      <div class="text-slate-800 dark:text-slate-200 font-medium line-clamp-1">\${item.src}</div>
                      <div class="text-indigo-600 dark:text-indigo-400 text-sm line-clamp-1 mt-1">\${item.dst}</div>
                  </div>
              \`).join('');
          }
  
          function restoreHistory(index) {
              const history = JSON.parse(localStorage.getItem('trans_history') || '[]');
              const item = history[index];
              if (item) {
                  els.input.value = item.src;
                  els.output.innerText = item.dst;
                  autoResize(els.input);
                  toggleHistory();
              }
          }
  
          function clearHistory() {
              localStorage.removeItem('trans_history');
              renderHistory();
              showToast("历史记录已清空");
          }
  
          function toggleHistory() {
              const panel = document.getElementById('historyPanel');
              const backdrop = document.getElementById('historyBackdrop');
              const isOpen = !panel.classList.contains('translate-x-full');
              
              if (isOpen) {
                  panel.classList.add('translate-x-full');
                  backdrop.classList.add('hidden');
              } else {
                  renderHistory();
                  panel.classList.remove('translate-x-full');
                  backdrop.classList.remove('hidden');
              }
          }
  
          // --- 5. 辅助功能 (朗读/复制/互换/清空) ---
          const speechLangMap = { 'chinese': 'zh-CN', 'english': 'en-US', 'japanese': 'ja-JP', 'korean': 'ko-KR', 'french': 'fr-FR', 'spanish': 'es-ES' };
          
          function speak(type) {
              if (window.speechSynthesis.speaking) { window.speechSynthesis.cancel(); return; }
              const text = type === 'source' ? els.input.value : els.output.innerText;
              if (!text) return;
              
              const u = new SpeechSynthesisUtterance(text);
              u.lang = speechLangMap[type === 'source' ? els.source.value : els.target.value] || 'en-US';
              
              const icon = document.querySelector(type === 'source' ? '#btnSpeakSource i' : '#btnSpeakTarget i');
              icon.classList.replace('ri-volume-up-line', 'ri-volume-up-fill');
              icon.parentElement.classList.add('speaking');
              
              u.onend = () => {
                  icon.classList.replace('ri-volume-up-fill', 'ri-volume-up-line');
                  icon.parentElement.classList.remove('speaking');
              };
              window.speechSynthesis.speak(u);
          }
  
          function copyResult() {
              if (!els.output.innerText) return;
              navigator.clipboard.writeText(els.output.innerText).then(() => showToast("已复制译文"));
          }
  
          function clearText() {
              els.input.value = ''; els.input.style.height = '120px'; els.output.innerText = '';
              els.charCount.innerText = '0 字';
          }
  
          function swapLanguages() {
              [els.source.value, els.target.value] = [els.target.value, els.source.value];
              if (els.output.innerText) {
                  els.input.value = els.output.innerText;
                  els.output.innerText = '';
                  autoResize(els.input);
                  doTranslate();
              }
          }
  
          els.target.addEventListener('change', () => { if(els.input.value.trim()) doTranslate(); });
  
          // --- 6. 摄像头 OCR ---
          const cameraModal = document.getElementById('cameraModal');
          const cameraVideo = document.getElementById('cameraVideo');
          const canvas = document.getElementById('canvas');
          let stream = null;
          const ocrLangMap = { 'english': 'eng', 'chinese': 'chi_sim', 'japanese': 'jpn', 'korean': 'kor' };
  
          async function openCamera() {
              try {
                  stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
                  cameraVideo.srcObject = stream;
                  cameraModal.classList.remove('hidden');
                  cameraModal.classList.add('flex');
              } catch (err) { showToast("无法访问摄像头"); }
          }
          function closeCamera() {
              cameraModal.classList.add('hidden');
              cameraModal.classList.remove('flex');
              if (stream) stream.getTracks().forEach(t => t.stop());
          }
          async function captureAndRecognize() {
              const ctx = canvas.getContext('2d');
              canvas.width = cameraVideo.videoWidth;
              canvas.height = cameraVideo.videoHeight;
              ctx.drawImage(cameraVideo, 0, 0);
              document.getElementById('ocrStatus').classList.remove('hidden');
              
              try {
                  const { data: { text } } = await Tesseract.recognize(canvas.toDataURL('image/png'), ocrLangMap[els.source.value] || 'eng');
                  closeCamera();
                  if (text.trim()) {
                      els.input.value = text;
                      autoResize(els.input);
                      doTranslate();
                  } else { showToast("未识别到文字"); }
              } catch (e) { showToast("OCR 识别出错"); } 
              finally { document.getElementById('ocrStatus').classList.add('hidden'); }
          }
      </script>
      <style>@keyframes scan { 0% {top:0;opacity:0} 10% {opacity:1} 90% {opacity:1} 100% {top:100%;opacity:0} }</style>
  </body>
  </html>
  `;