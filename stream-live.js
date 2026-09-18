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
    console.log("🚀 بدء محرك البث اللحظي (Perfect Sync Engine)...");
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

    console.log("3. تجهيز خط أنابيب FFmpeg للمزامنة الصارمة...");
    
    // ترتيب المداخل لضمان التزامن
    const videoInputIndex = hasAudio ? '1' : '0';
    const audioInputIndex = '0';

    const ffmpegArgs = [
        '-y',
        '-loglevel', 'warning',

        // [المدخل 0]: الصوت (هو التوقيت الماستر، يقرأ بسرعة حقيقية ويتكرر)
        ...(hasAudio ? ['-re', '-stream_loop', '-1', '-i', 'temp_live_audio.wav'] : []),
        
        // [المدخل 1]: الصورة 
        // السر هنا: استخدام ساعة السيرفر الحقيقية كطابع زمني للفريمات لمنع أي تسريع!
        '-use_wallclock_as_timestamps', '1',
        '-f', 'image2pipe',
        '-vcodec', 'mjpeg',
        '-i', '-', 
        
        // خريطة الدمج
        '-map', `${videoInputIndex}:v:0`,
        ...(hasAudio ? ['-map', `${audioInputIndex}:a:0`] : []),

        // ترميز الفيديو مع الحفاظ على التزامن
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-tune', 'zerolatency',
        '-r', String(FPS), // إجبار الخرج على 30 فريم (سينسخ الفريمات الناقصة لضبط الصوت)
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

    console.log("4. تنظيف واجهة المتصفح وبدء ضخ الفريمات...");
    
    // إخفاء الأزرار وبدء العرض المتزامن
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

    client.on('Page.screencastFrame', async (frameObject) => {
        if (ffmpeg.stdin.writable) {
            ffmpeg.stdin.write(Buffer.from(frameObject.data, 'base64'));
        }
        await client.send('Page.screencastFrameAck', { sessionId: frameObject.sessionId }).catch(()=>{});
    });

    process.on('SIGINT', () => {
        console.log("\nإيقاف البث...");
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
