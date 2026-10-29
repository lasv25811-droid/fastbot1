// ==================== HTTP SERVER (Web Service üçün) ====================
import http from 'http';

const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    ok: true,
    bot: 'chcgreen-bot',
    uptime: Math.floor(process.uptime()),
    time: new Date().toISOString()
  }));
});

server.listen(PORT, () => {
  log(`🌐 HTTP server: port ${PORT}`);
});

// Bot loop-u ayrıca başlat
main().catch(e => { console.error('FATAL:', e); process.exit(1); });