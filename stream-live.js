import puppeteer from 'puppeteer';
import { spawn, execSync } from 'child_process';
import http from 'http';
import fs from 'fs';
import path from 'path';

const MODE = process.env.MODE || 'dummy_test'; // test_fps | dummy_test | live
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

async function runUnifiedEngine() {
    console.log("==========================================");
    console.log(`🚀 تشغيل المحرك الموحد في وضع: [ ${MODE.toUpperCase()} ]`);
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
    await page.setViewport({ width: 1920, height: 1080 });
    page.on('console', msg => console.log(`[Browser]: ${msg.text()}`));

    console.log("⏳ جاري فتح المشهد وتحميل الأصول والتلاوة...");
    await page.goto(`http://127.0.0.1:${port}/scene.html`, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction(() => window.renderStatus === 'ready', { timeout: 120000 });
    console.log("✓ تم تجهيز الكانفاس والمشهد بنجاح!");

    // إخفاء الواجهات وضبط التزامن الصارم
    await page.evaluate(() => {
        if (typeof window.startHeadlessLiveStream === 'function') {
            window.startHeadlessLiveStream();
        } else if (typeof startPreviewLoop === 'function') {
            startPreviewLoop();
        }
    });

    // -------------------------------------------------------------
    // الوضع 1: قياس سرعة الفريمات فقط (TEST_FPS)
    // -------------------------------------------------------------
    if (MODE === 'test_fps') {
        console.log("\n🔬 بدء قياس معدل الفريمات الحقيقي (FPS)...");
        const client = await page.target().createCDPSession();
        await client.send('Page.startScreencast', { format: 'jpeg', quality: 85, everyNthFrame: 1 });

        let framesReceived = 0;
        let totalBytes = 0;
        client.on('Page.screencastFrame', async (frameObject) => {
            framesReceived++;
            totalBytes += Buffer.from(frameObject.data, 'base64').length;
            await client.send('Page.screencastFrameAck', { sessionId: frameObject.sessionId }).catch(()=>{});
        });

        let sec = 0;
        const interval = setInterval(() => {
            sec++;
            const kbps = (totalBytes / 1024).toFixed(2);
            console.log(`[ثانية ${String(sec).padStart(2, '0')}] 📊 الفريمات المستلمة: ${framesReceived} FPS | حجم البيانات: ${kbps} KB/s`);
            framesReceived = 0;
            totalBytes = 0;

            if (sec >= 20) {
                clearInterval(interval);
                console.log("\n✅ انتهى فحص الفريمات بنجاح!");
                browser.close();
                server.close();
                process.exit(0);
            }
        }, 1000);
        return;
    }

    // -------------------------------------------------------------
    // الوضع 2 و 3: البث المباشر (LIVE) أو البث الوهمي للـ Releases (DUMMY_TEST)
    // -------------------------------------------------------------
    const audioBase64 = await page.evaluate(() => window.__ofoqAudioWavBase64);
    const hasAudio = !!audioBase64;
    if (hasAudio) {
        fs.writeFileSync('temp_live_audio.wav', Buffer.from(audioBase64, 'base64'));
    }

    const isDummy = (MODE === 'dummy_test');
    const outputTarget = isDummy ? 'live_test_output.mp4' : RTMP_DESTINATION;

    console.log(`\n3. تهيئة خط أنابيب FFmpeg (${isDummy ? 'تسجيل دقيقة للاختبار' : 'بث مباشر ليوتيوب'})...`);

    const ffmpegArgs = [
        '-y',
        '-loglevel', 'warning',
        '-f', 'image2pipe',
        '-vcodec', 'mjpeg',
        '-framerate', String(FPS),
        '-i', '-',
        ...(hasAudio ? ['-stream_loop', '-1', '-re', '-i', 'temp_live_audio.wav'] : []),
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
        ...(isDummy ? ['-t', '60'] : ['-f', 'flv', '-flvflags', 'no_duration_filesize']),
        outputTarget
    ];

    const ffmpeg = spawn('ffmpeg', ffmpegArgs);

    ffmpeg.stdin.on('error', (e) => {
        if (e.code !== 'EPIPE') console.error('FFmpeg Stdin Error:', e);
    });

    ffmpeg.stderr.on('data', (d) => {
        const msg = d.toString();
        if (msg.includes('frame=')) {
            process.stdout.write(`\r[${isDummy ? 'Dummy Test' : 'Live RTMP'}]: ${msg.trim()}`);
        } else {
            console.log(`\n[FFmpeg]: ${msg.trim()}`);
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

    console.log("\n4. بدء ضخ الفريمات المتزامنة...");
    const startStreamTime = Date.now();
    let framesSent = 0;

    const pumperInterval = setInterval(() => {
        if (!ffmpeg.stdin.writable) return;
        const now = Date.now();
        const elapsedSec = (now - startStreamTime) / 1000;
        const targetFrames = Math.floor(elapsedSec * FPS);
        const framesToPush = targetFrames - framesSent;

        for (let i = 0; i < framesToPush; i++) {
            try {
                ffmpeg.stdin.write(lastFrameBuffer);
                framesSent++;
            } catch(e) { break; }
        }
    }, 10);

    ffmpeg.on('close', () => {
        clearInterval(pumperInterval);

        if (isDummy) {
            console.log("\n\n✅ اكتمل تسجيل الدقيقة الاختبارية بنجاح!");
            console.log("🚀 جاري رفع الفيديو الآن إلى صفحة Releases في مستودعك...");
            try {
                const tagName = `Test-Sync-${Date.now()}`;
                const cmd = `gh release create ${tagName} live_test_output.mp4 --title "اختبار تزامن البث (${new Date().toLocaleString()})" --notes "فيديو اختباري للتأكد من تطابق الصوت والآيات والتفسير."`;
                execSync(cmd, { stdio: 'inherit' });
                console.log("\n🎉 تم الرفع بنجاح! اذهب لقسم Releases على يمين صفحة المستودع وحمّل الفيديو.");
            } catch (err) {
                console.error("\n❌ تنبيه بخصوص رفع الـ Release:", err.message);
            }
        }

        browser.close();
        server.close();
        process.exit(0);
    });
}

runUnifiedEngine().catch((err) => {
    console.error("فشل التشغيل:", err);
    process.exit(1);
});
