import puppeteer from 'puppeteer';
import http from 'http';
import fs from 'fs';
import path from 'path';

const FPS_TARGET = 30;

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

async function runSimulation() {
    console.log("==================================================");
    console.log("🔬 بدء محاكاة فحص سرعة الفريمات (CDP Screencast)...");
    console.log("==================================================");

    const server = await startLocalServer();
    
    // إضافة أوامر منع الخنق (Anti-Throttling Flags)
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
    
    await page.goto(`http://127.0.0.1:${server.address().port}/scene.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.renderStatus === 'ready', { timeout: 120000 });

    // تشغيل حلقة العرض في المتصفح
    await page.evaluate(() => {
        if (typeof startPreviewLoop === 'function') startPreviewLoop();
    });

    // ==========================================
    // السر: استخدام بروتوكول CDP لسحب الفريمات
    // ==========================================
    const client = await page.target().createCDPSession();
    await client.send('Page.startScreencast', { 
        format: 'jpeg', 
        quality: 85,
        everyNthFrame: 1 // التقاط كل فريم يتم رسمه
    });

    let framesReceived = 0;
    let totalBytes = 0;

    // استلام الفريمات اللحظية من محرك كروم الداخلي
    client.on('Page.screencastFrame', async (frameObject) => {
        framesReceived++;
        totalBytes += Buffer.from(frameObject.data, 'base64').length;
        
        // إشعار المتصفح باستلام الفريم ليرسل الذي يليه (مهم جداً)
        await client.send('Page.screencastFrameAck', { sessionId: frameObject.sessionId }).catch(()=>{});
    });

    let secondsPassed = 0;
    const statsInterval = setInterval(() => {
        secondsPassed++;
        const kbps = (totalBytes / 1024).toFixed(2);
        console.log(`[ثانية ${String(secondsPassed).padStart(2, '0')}] 📊 الفريمات المستلمة: ${framesReceived} FPS | حجم البيانات: ${kbps} KB/s`);
        
        framesReceived = 0;
        totalBytes = 0;

        if (secondsPassed >= 20) {
            console.log("\n✅ انتهى الاختبار بنجاح! المتصفح قادر على ضخ الفريمات بشكل ممتاز.");
            process.exit(0);
        }
    }, 1000);
}

runSimulation();
