const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');
const cron = require('node-cron');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*" } });

const JWT_SECRET = "CORTEZ_MAFIA_SECURE_2026";
const PORT = process.env.PORT || 3000;
const MONGO_URI = 'mongodb+srv://moha:cutureire@cluster0.qgk83qz.mongodb.net/cortez?appName=Cluster0';

mongoose.connect(MONGO_URI)
  .then(() => console.log('✓ Cortez System v6.1 Online'))
  .catch(err => console.error('❌ DB Error:', err));

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const User = mongoose.model('User', new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    role: { type: String, enum: ['Don', 'HR_Manager', 'Soldier'], default: 'Soldier' },
    duty_status: { type: String, enum: ['ON-DUTY', 'OFF-DUTY'], default: 'OFF-DUTY' },
    last_punch_in: Date,
    weekly_hours: { type: Number, default: 0 }
}));

// API Routes
app.post('/api/auth/register', async (req, res) => {
    try {
        const { username, password } = req.body;
        const hashedPassword = await bcrypt.hash(password, 10);
        const isFirst = (await User.countDocuments({})) === 0;
        await new User({ username, password: hashedPassword, role: isFirst ? 'Don' : 'Soldier' }).save();
        res.status(201).json({ msg: "Success" });
    } catch (e) { res.status(400).json({ error: "Taken" }); }
});

app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    const user = await User.findOne({ username });
    if (!user || !(await bcrypt.compare(password, user.password))) return res.status(400).json({ error: "Error" });
    res.json({ user: { username: user.username, role: user.role, duty_status: user.duty_status } });
});

app.get('/api/stats', async (req, res) => {
    const users = await User.find({}, 'username weekly_hours role duty_status');
    res.json(users.sort((a,b) => b.weekly_hours - a.weekly_hours));
});

app.post('/api/admin/reset', async (req, res) => {
    await User.updateMany({}, { weekly_hours: 0, duty_status: 'OFF-DUTY' });
    io.emit('update');
    res.json({ msg: "Archived & Reset" });
});

// Real-time logic
io.on('connection', (socket) => {
    socket.on('toggleDuty', async (data) => {
        const user = await User.findOne({ username: data.username });
        if (!user) return;
        if (user.duty_status === 'OFF-DUTY') {
            user.duty_status = 'ON-DUTY'; user.last_punch_in = new Date();
        } else {
            user.weekly_hours += Math.floor((new Date() - user.last_punch_in) / 60000);
            user.duty_status = 'OFF-DUTY';
        }
        await user.save();
        io.emit('update');
    });
    socket.on('emergency', (msg) => io.emit('alert', msg));
});

// Anti-AFK (يغلق الدوام تلقائياً بعد 8 ساعات)
cron.schedule('0 * * * *', async () => {
    const active = await User.find({ duty_status: 'ON-DUTY' });
    active.forEach(async u => {
        if (new Date() - u.last_punch_in > 28800000) {
            u.weekly_hours += Math.floor((new Date() - u.last_punch_in) / 60000);
            u.duty_status = 'OFF-DUTY';
            await u.save();
            io.emit('update');
        }
    });
});

server.listen(PORT, () => console.log(`Server Running on ${PORT}`));
