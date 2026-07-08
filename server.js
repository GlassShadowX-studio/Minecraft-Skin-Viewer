const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

//前端通过 import map 读取three.js
app.use('/node_modules/three', express.static(path.join(__dirname, 'node_modules/three')));

const cache = new Map();
const CACHE_TTL = 10 * 60 * 1000;

async function fetchWithCache(key, fetchFn) {
    if (cache.has(key) && Date.now() - cache.get(key).time < CACHE_TTL) return cache.get(key).data;
    const data = await fetchFn();
    cache.set(key, { data, time: Date.now() });
    return data;
}

app.get('/api/profile/:username', async (req, res) => {
    try {
        const { username } = req.params;
        const data = await fetchWithCache(`profile_${username}`, async () => {
            const response = await axios.get(`https://api.mojang.com/users/profiles/minecraft/${username}`);
            return response.data;
        });
        res.json(data);
    } catch (error) { res.status(404).json({ error: 'Player not found' }); }
});

app.get('/api/session/:uuid', async (req, res) => {
    try {
        const { uuid } = req.params;
        const data = await fetchWithCache(`session_${uuid}`, async () => {
            const response = await axios.get(`https://sessionserver.mojang.com/session/minecraft/profile/${uuid}`);
            return response.data;
        });
        let skinUrl = null, capeUrl = null, model = 'classic';
        const prop = data.properties.find(p => p.name === 'textures');
        if (prop) {
            const decoded = JSON.parse(Buffer.from(prop.value, 'base64').toString('utf-8'));
            if (decoded.textures.SKIN) {
                skinUrl = decoded.textures.SKIN.url;
                if (decoded.textures.SKIN.metadata && decoded.textures.SKIN.metadata.model === 'slim') model = 'slim';
            }
            if (decoded.textures.CAPE) capeUrl = decoded.textures.CAPE.url;
        }
        res.json({ uuid: data.id, name: data.name, skinUrl, capeUrl, model });
    } catch (error) { res.status(500).json({ error: 'Failed to fetch session data' }); }
});

app.get('/api/texture', async (req, res) => {
    try {
        const { url } = req.query;
        if (!url || !url.includes('textures.minecraft.net')) return res.status(400).send('Invalid URL');
        const response = await axios.get(url, { responseType: 'arraybuffer' });
        res.set('Content-Type', 'image/png');
        res.send(response.data);
    } catch (error) { res.status(500).send('Failed to fetch texture'); }
});

const defaultSkins = {
    classic: 'https://starlightskins.lunareclipse.studio/skins/8667ba71-b85a-4004-af54-457a9734eed7',
    slim: 'https://starlightskins.lunareclipse.studio/skins/ec70bcaf-702f-4bb8-b78e-5d35f44f8c39'
};
app.get('/api/default-skin/:model', async (req, res) => {
    const model = req.params.model === 'slim' ? 'slim' : 'classic';
    try {
        const response = await axios.get(defaultSkins[model], { responseType: 'arraybuffer' });
        res.set('Content-Type', 'image/png');
        res.send(response.data);
    } catch (e) { res.status(500).send('Failed to fetch default skin'); }
});

app.listen(PORT, () => {
    console.log(`\x1b[32m%s\x1b[0m`, `Mc皮肤预览 Server running on http://localhost:${PORT}`);
});