const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*" } });

const JWT_SECRET = "CORTEZ_MAFIA_SECURE_KEY_2026";
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://moha:cutureire@cluster0.qgk83qz.mongodb.net/cortez?appName=Cluster0';

mongoose.connect(MONGO_URI).then(() => console.log('✓ Connected to Cortez DB v5.7')).catch(err => console.error(err));

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Schemas
const UserSchema = new mongoose.Schema({
    username: String, password: String, role: String, duty_status: { type: String, default: 'OFF-DUTY' },
    last_punch_in: Date, weekly_hours: { type: Number, default: 0 }, warnings: { type: Number, default: 0 }, is_blacklisted: { type: Boolean, default: false }
});
const AdminLogSchema = new mongoose.Schema({ admin_username: String, action: String, target: String, timestamp: { type: Date, default: Date.now } });
const User = mongoose.model('User', UserSchema);
const AdminLog = mongoose.model('AdminLog', AdminLogSchema);

// Auth Middleware
const verifyAuth = (roles) => (req, res, next) => {
    const token = req.headers['authorization']?.split(' ')[1];
    if (!token) return res.status(401).json({ error: "Unauthorized" });
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        if (roles.length > 0 && !roles.includes(decoded.role) && decoded.role !== 'Don') return res.status(403).json({ error: "Forbidden" });
        req.user = decoded; next();
    } catch { res.status(400).json({ error: "Invalid Token" }); }
};

// Routes
app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    const user = await User.findOne({ username });
    if (!user || !(await bcrypt.compare(password, user.password))) return res.status(400).json({ error: "Login failed" });
    const token = jwt.sign({ id: user._id, role: user.role, username: user.username }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ token, user: { username: user.username, role: user.role, duty_status: user.duty_status } });
});

app.get('/api/admin/logs', verifyAuth(['Don']), async (req, res) => {
    const logs = await AdminLog.find().sort({ timestamp: -1 }).limit(20);
    res.json(logs);
});

// Sockets
io.on('connection', (socket) => {
    socket.on('emergencyAlert', (data) => { io.emit('emergencyAlert', data); });
    socket.on('toggleDuty', async (data) => {
        const user = await User.findOne({ username: data.username });
        if (user.duty_status === 'OFF-DUTY') { user.duty_status = 'ON-DUTY'; user.last_punch_in = new Date(); }
        else { user.weekly_hours += Math.floor((new Date() - user.last_punch_in) / 60000); user.duty_status = 'OFF-DUTY'; }
        await user.save();
        io.emit('dutyUpdated', {});
    });
});

server.listen(PORT, () => console.log(`📡 System v5.7 running`));
