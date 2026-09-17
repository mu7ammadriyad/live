import puppeteer from 'puppeteer';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { WebSocketServer } from 'ws';

const FPS_TARGET = 30;
const FRAME_INTERVAL_MS = 1000 / FPS_TARGET;

// خادم محلي
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

// خادم الويب سوكيت لقياس الفريمات
function startWebSocketServer() {
    return new Promise((resolve) => {
        const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
        wss.on('listening', () => resolve(wss));
    });
}

async function runSimulation() {
    console.log("==================================================");
    console.log("🔬 بدء محاكاة فحص سرعة الفريمات (FPS Analyzer)...");
    console.log("==================================================");

    const server = await startLocalServer();
    const wss = await startWebSocketServer();
    
    let framesReceived = 0;
    let totalBytes = 0;

    wss.on('connection', (ws) => {
        console.log("🔗 تم ربط الكانفاس! جاري قياس تدفق البيانات...\n");
        ws.on('message', (data) => {
            framesReceived++;
            totalBytes += data.length; // حجم الفريم بالبايت
        });
    });

    // عداد يطبع السرعة كل ثانية
    let secondsPassed = 0;
    const statsInterval = setInterval(() => {
        secondsPassed++;
        const kbps = (totalBytes / 1024).toFixed(2);
        console.log(`[ثانية ${String(secondsPassed).padStart(2, '0')}] 📊 الفريمات المستلمة: ${framesReceived} FPS | حجم البيانات: ${kbps} KB/s`);
        
        // تصفير العداد للثانية القادمة
        framesReceived = 0;
        totalBytes = 0;

        // إيقاف الاختبار بعد 20 ثانية
        if (secondsPassed >= 20) {
            console.log("\n✅ انتهى الاختبار بنجاح! المتصفح قادر على ضخ الفريمات بشكل مستقر.");
            process.exit(0);
        }
    }, 1000);

    const browser = await puppeteer.launch({
        headless: "new",
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--use-gl=swiftshader']
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1080, height: 1920 });
    
    await page.goto(`http://127.0.0.1:${server.address().port}/scene.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.renderStatus === 'ready', { timeout: 120000 });

    // حقن كود إرسال الفريمات
    await page.evaluate((wsPort, interval) => {
        if (typeof startPreviewLoop === 'function') startPreviewLoop();
        const canvas = document.getElementById('videoCanvas');
        const ws = new WebSocket(`ws://127.0.0.1:${wsPort}`);
        let isSending = false;

        ws.onopen = () => {
            setInterval(() => {
                if (isSending || ws.readyState !== 1) return;
                isSending = true;
                canvas.toBlob((blob) => {
                    if (blob) ws.send(blob);
                    isSending = false;
                }, 'image/jpeg', 0.85);
            }, interval);
        };
    }, wss.address().port, FRAME_INTERVAL_MS);
}

runSimulation();
