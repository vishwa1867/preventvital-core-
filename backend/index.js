const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const { extractFromUploads } = require('./upload');

const app = express();
const PORT = Number(process.env.PORT) || 5000;  // Render/cloud hosts inject PORT
const HOST = '0.0.0.0'; // Listen on all network interfaces

app.use(cors());
app.use(express.json());

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 15 * 1024 * 1024, files: 5 }
});

app.get('/', (req, res) => {
    res.send('PreventVital Core OCR Server is running and open to the network!');
});

app.post('/api/extract', upload.array('reports', 5), (req, res) => {
    console.log('Processing report request from:', req.ip);
    try {
        const result = extractFromUploads(req.files, { full: req.query.full === '1' });
        if (result.ok) {
            res.status(200).json(result);
        } else {
            res.status(422).json(result);
        }
    } catch (error) {
        console.error('OCR Error:', error);
        res.status(500).json({
            ok: false,
            messages: [{ level: 'action', text: `Server Error: ${error.message}` }]
        });
    }
});

app.listen(PORT, HOST, () => {
    console.log(`🚀 Core OCR Server running!`);
    console.log(`Listening on http://${HOST}:${PORT}`);
    if (process.env.RENDER_EXTERNAL_URL) console.log(`Public: ${process.env.RENDER_EXTERNAL_URL}`);
});
