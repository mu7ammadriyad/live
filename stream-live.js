import puppeteer from 'puppeteer';
import { spawn } from 'child_process';
import http from 'http';
import fs from 'fs';
import path from 'path';

const STREAM_KEY = process.env.YOUTUBE_STREAM_KEY || "YOUR_STREAM_KEY_HERE";
const RTMP_DESTINATION = `rtmp://a.rtmp.youtube.com/live2/${STREAM_KEY}`;
const FPS = 30;

function startLocalServer() {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            let reqPath = decodeURIComponent(req.url.split('?')[0]);
            if (reqPath === '/favicon.ico') { res.writeHead(204); res.end(); return; }
            if (reqPath === '/' || reqPath === '') reqPath = '/scene.html';
            const filePath = path.join(process.cwd(), reqPath);
            fs.readFile(filePath, (err, data) => {
                if (err) { res.writeHead(404); res.end('Not Found'); return; }
                res.writeHead(200); res.end(data);
            });
        });
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

async function startLiveStream() {
    console.log("==========================================");
    console.log("🚀 بدء محرك البث اللحظي المتزامن (Strict Frame Pumper)...");
    console.log("==========================================");

    const server = await startLocalServer();
    const port = server.address().port;

    console.log(`1. تشغيل المتصفح الخفي...`);
    const browser = await puppeteer.launch({
        headless: "new",
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--use-gl=swiftshader',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding'
        ]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1080, height: 1920 });
    page.on('console', msg => console.log(`[Browser]: ${msg.text()}`));
    
    console.log("2. فتح صفحة المشهد...");
    await page.goto(`http://127.0.0.1:${port}/scene.html`, { 
        waitUntil: 'domcontentloaded',
        timeout: 120000 
    });

    await page.waitForFunction(() => window.renderStatus === 'ready', { timeout: 120000 });
    console.log("✓ تم تجهيز الكانفاس والمشهد!");

    const audioBase64 = await page.evaluate(() => window.__ofoqAudioWavBase64);
    const hasAudio = !!audioBase64;
    if (hasAudio) {
        fs.writeFileSync('temp_live_audio.wav', Buffer.from(audioBase64, 'base64'));
        console.log("✓ تم استخراج ملف الصوت للمزامنة.");
    }

    console.log("3. تجهيز خط أنابيب FFmpeg...");
    const ffmpegArgs = [
        '-y',
        '-loglevel', 'warning',
        
        // إعدادات مدخل الفيديو (استقبال من الـ Pumper)
        '-f', 'image2pipe',
        '-vcodec', 'mjpeg',
        '-framerate', String(FPS),
        '-i', '-', 

        // إعدادات مدخل الصوت (سرعة حقيقية وتكرار لا نهائي)
        ...(hasAudio ? ['-re', '-stream_loop', '-1', '-i', 'temp_live_audio.wav'] : []),
        
        '-map', '0:v:0',
        ...(hasAudio ? ['-map', '1:a:0'] : []),

        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-tune', 'zerolatency',
        '-b:v', '3000k',
        '-maxrate', '3500k',
        '-bufsize', '7000k',
        '-pix_fmt', 'yuv420p',
        '-g', String(FPS * 2),
        
        ...(hasAudio ? ['-c:a', 'aac', '-b:a', '128k', '-ar', '44100'] : []),
        
        '-f', 'flv',
        RTMP_DESTINATION
    ];

    const ffmpeg = spawn('ffmpeg', ffmpegArgs);

    ffmpeg.stderr.on('data', (d) => {
        const msg = d.toString();
        if (msg.includes('frame=')) {
            process.stdout.write(`\r[Live RTMP]: ${msg.trim()}`);
        } else {
            console.log(`[FFmpeg]: ${msg.trim()}`);
        }
    });

    console.log("4. بدء المزامنة الرياضية الصارمة (Mathematical Sync)...");
    
    // إخفاء الواجهات وبدء العرض
    await page.evaluate(() => {
        if (typeof window.startHeadlessLiveStream === 'function') {
            window.startHeadlessLiveStream();
        }
    });

    const client = await page.target().createCDPSession();
    await client.send('Page.startScreencast', { 
        format: 'jpeg', 
        quality: 85,
        everyNthFrame: 1 
    });

    let lastFrameBuffer = null;

    client.on('Page.screencastFrame', async (frameObject) => {
        lastFrameBuffer = Buffer.from(frameObject.data, 'base64');
        await client.send('Page.screencastFrameAck', { sessionId: frameObject.sessionId }).catch(()=>{});
    });

    // انتظار وصول أول فريم لضمان عدم وجود شاشة سوداء
    while (!lastFrameBuffer) {
        await new Promise(r => setTimeout(r, 50));
    }

    // =========================================================
    // ⚙️ المحرك السري: ضخ الفريمات بشكل إجباري 30 مرة في الثانية
    // =========================================================
    const startStreamTime = Date.now();
    let framesSent = 0;

    const pumperInterval = setInterval(() => {
        if (!ffmpeg.stdin.writable) return;

        const now = Date.now();
        const elapsedSec = (now - startStreamTime) / 1000;
        
        // حساب كم فريم كان يجب أن يُرسل حتى هذه اللحظة بالضبط
        const targetFrames = Math.floor(elapsedSec * FPS);
        
        // إذا كان السيرفر متأخراً، أرسل الفريمات الناقصة (نسخ الفريم الأخير)
        const framesToPush = targetFrames - framesSent;

        for (let i = 0; i < framesToPush; i++) {
            ffmpeg.stdin.write(lastFrameBuffer);
            framesSent++;
        }
    }, 10); // يفحص الوقت كل 10 مللي ثانية ليضمن الدقة القصوى

    process.on('SIGINT', () => {
        console.log("\nإيقاف البث...");
        clearInterval(pumperInterval);
        ffmpeg.stdin.end();
        browser.close();
        server.close();
        process.exit(0);
    });
}

startLiveStream().catch((err) => {
    console.error("فشل تشغيل البث:", err);
    process.exit(1);
});
