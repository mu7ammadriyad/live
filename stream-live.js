import puppeteer from 'puppeteer';
import { spawn } from 'child_process';
import http from 'http';
import fs from 'fs';
import path from 'path';

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

async function startDummyStream() {
    console.log("==========================================");
    console.log("🛠️ بدء محرك البث الوهمي (Local Dummy Stream)...");
    console.log("==========================================");

    const server = await startLocalServer();
    const port = server.address().port;

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
    
    await page.goto(`http://127.0.0.1:${port}/scene.html`, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction(() => window.renderStatus === 'ready', { timeout: 120000 });
    console.log("✓ تم تجهيز الكانفاس والمشهد!");

    const audioBase64 = await page.evaluate(() => window.__ofoqAudioWavBase64);
    const hasAudio = !!audioBase64;
    if (hasAudio) {
        fs.writeFileSync('temp_live_audio.wav', Buffer.from(audioBase64, 'base64'));
    }

    console.log("3. تجهيز خط أنابيب FFmpeg لتسجيل بث وهمي (دقيقة واحدة)...");
    
    const ffmpegArgs = [
        '-y',
        '-loglevel', 'warning',
        
        // إعدادات مدخل الفيديو (استقبال من الـ Pumper)
        '-f', 'image2pipe',
        '-vcodec', 'mjpeg',
        '-framerate', String(FPS),
        '-i', '-', 

        // إعدادات الصوت
        ...(hasAudio ? ['-re', '-i', 'temp_live_audio.wav'] : []),
        
        '-map', '0:v:0',
        ...(hasAudio ? ['-map', '1:a:0'] : []),

        // ترميز مطابق تماماً لإعدادات البث المباشر
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-tune', 'zerolatency',
        '-b:v', '3000k',
        '-maxrate', '3500k',
        '-bufsize', '7000k',
        '-pix_fmt', 'yuv420p',
        '-g', String(FPS * 2),
        ...(hasAudio ? ['-c:a', 'aac', '-b:a', '128k', '-ar', '44100'] : []),
        
        // تحديد المدة بـ 60 ثانية فقط للاختبار
        '-t', '60',
        
        // الحفظ كملف MP4 بدلاً من الإرسال ليوتيوب
        'live_test_output.mp4'
    ];

    const ffmpeg = spawn('ffmpeg', ffmpegArgs);

    ffmpeg.stderr.on('data', (d) => {
        const msg = d.toString();
        if (msg.includes('frame=')) {
            process.stdout.write(`\r[Dummy Stream]: ${msg.trim()}`);
        }
    });

    console.log("4. بدء ضخ الفريمات باستخدام (Strict Frame Pumper)...");
    
    await page.evaluate(() => {
        if (typeof window.startHeadlessLiveStream === 'function') {
            window.startHeadlessLiveStream();
        }
    });

    const client = await page.target().createCDPSession();
    await client.send('Page.startScreencast', { format: 'jpeg', quality: 85, everyNthFrame: 1 });

    let lastFrameBuffer = null;
    client.on('Page.screencastFrame', async (frameObject) => {
        lastFrameBuffer = Buffer.from(frameObject.data, 'base64');
        await client.send('Page.screencastFrameAck', { sessionId: frameObject.sessionId }).catch(()=>{});
    });

    while (!lastFrameBuffer) {
        await new Promise(r => setTimeout(r, 50));
    }

    const startStreamTime = Date.now();
    let framesSent = 0;

    const pumperInterval = setInterval(() => {
        if (!ffmpeg.stdin.writable) return;
        const now = Date.now();
        const elapsedSec = (now - startStreamTime) / 1000;
        const targetFrames = Math.floor(elapsedSec * FPS);
        const framesToPush = targetFrames - framesSent;

        for (let i = 0; i < framesToPush; i++) {
            ffmpeg.stdin.write(lastFrameBuffer);
            framesSent++;
        }
    }, 10);

    // عند انتهاء FFmpeg من تسجيل الـ 60 ثانية، سيغلق نفسه
    ffmpeg.on('close', () => {
        console.log("\n✅ انتهى البث الوهمي! تم حفظ الملف: live_test_output.mp4");
        clearInterval(pumperInterval);
        browser.close();
        server.close();
        process.exit(0);
    });
}

startDummyStream().catch((err) => {
    console.error("فشل التشغيل:", err);
    process.exit(1);
});
