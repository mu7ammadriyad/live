import puppeteer from 'puppeteer';
import { spawn, execSync } from 'child_process';
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
    // ضبط المقاس ليتوافق مع شاشة التلفزيون العريضة 16:9
    await page.setViewport({ width: 1920, height: 1080 });
    
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
        
        // إعدادات مدخل الفيديو
        '-f', 'image2pipe',
        '-vcodec', 'mjpeg',
        '-framerate', String(FPS),
        '-i', '-', 

        // إعدادات الصوت (تشغيل مستمر)
        ...(hasAudio ? ['-stream_loop', '-1', '-re', '-i', 'temp_live_audio.wav'] : []),
        
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
        
        // إيقاف التسجيل بعد 60 ثانية بالضبط
        '-t', '60', 
        
        'live_test_output.mp4'
    ];

    const ffmpeg = spawn('ffmpeg', ffmpegArgs);

    // معالجة خطأ EPIPE حتى لا ينهار الـ Node.js
    ffmpeg.stdin.on('error', (e) => {
        if (e.code !== 'EPIPE') {
            console.error('FFmpeg Stdin Error:', e);
        }
    });

    ffmpeg.stderr.on('data', (d) => {
        const msg = d.toString();
        if (msg.includes('frame=')) {
            process.stdout.write(`\r[Dummy Stream]: ${msg.trim()}`);
        } else {
            console.log(`\n[FFmpeg Log]: ${msg.trim()}`);
        }
    });

    console.log("\n4. بدء ضخ الفريمات باستخدام (Strict Frame Pumper)...");
    
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
        if (!ffmpeg.stdin.writable) return; // توقف إذا تم إغلاق الأنبوب
        
        const now = Date.now();
        const elapsedSec = (now - startStreamTime) / 1000;
        const targetFrames = Math.floor(elapsedSec * FPS);
        const framesToPush = targetFrames - framesSent;

        for (let i = 0; i < framesToPush; i++) {
            try {
                ffmpeg.stdin.write(lastFrameBuffer);
                framesSent++;
            } catch(e) {
                break;
            }
        }
    }, 10);

    // الرفع التلقائي إلى Github Releases عند الانتهاء
    ffmpeg.on('close', () => {
        console.log("\n\n✅ انتهى تسجيل البث الوهمي بنجاح! تم حفظ: live_test_output.mp4");
        clearInterval(pumperInterval);
        
        console.log("🚀 جاري رفع الفيديو إلى صفحة Releases في مستودعك...");
        try {
            const tagName = `Test-Sync-${Date.now()}`;
            const command = `gh release create ${tagName} live_test_output.mp4 --title "اختبار تزامن البث (${new Date().toLocaleString()})" --notes "ملف اختبار لدقيقة واحدة للتأكد من تزامن الصوت مع الآيات والتفسير."`;
            
            execSync(command, { stdio: 'inherit' });
            console.log("\n🎉 تم رفع الفيديو بنجاح! اذهب إلى صفحة Releases في جيتهاب لتحميله.");
        } catch (error) {
            console.error("\n❌ فشل رفع الملف إلى Releases (ربما بسبب عدم وجود صلاحيات Write في ملف الـ YML).");
            console.log("💡 لا تقلق، ستجد الفيديو في قسم (Artifacts) أسفل صفحة الـ Action الحالية لتقوم بتحميله.");
        }

        browser.close();
        server.close();
        process.exit(0);
    });
}

startDummyStream().catch((err) => {
    console.error("فشل التشغيل:", err);
    process.exit(1);
});
