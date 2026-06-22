// ==========================================================
// CORTEZ MAFIA - SYSTEM BACKEND (v4.0 ACTIVE DUTY)
// ==========================================================
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

// الاتصال بقاعدة بيانات عائلة كورتيز الرسمية
mongoose.connect('mongodb://localhost:27017/cortez_mafia')
  .then(() => console.log('✓ Connected Strictly to Cortez DB.'))
  .catch(err => console.error('❌ Database Error:', err));

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================================
// 1. SCHEMAS & MODELS
// ==========================================================

const UserSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    discord_id: { type: String, required: true },
    role: { type: String, enum: ['Don', 'HR_Manager', 'Soldier'], default: 'Soldier' },
    duty_status: { type: String, enum: ['ON-DUTY', 'OFF-DUTY'], default: 'OFF-DUTY' },
    last_punch_in: { type: Date },
    weekly_hours: { type: Number, default: 0 } // مخزنة كـ دقائق إجمالية لتسهيل الحساب الدقيق
});

const LeaveSchema = new mongoose.Schema({
    username: String,
    reason: String,
    duration: Number,
    status: { type: String, enum: ['Pending', 'Approved', 'Rejected'], default: 'Pending' },
    timestamp: { type: Date, default: Date.now }
});

const JustificationSchema = new mongoose.Schema({
    username: String,
    reason: String,
    status: { type: String, enum: ['Pending', 'Approved', 'Rejected'], default: 'Pending' },
    timestamp: { type: Date, default: Date.now }
});

const User = mongoose.model('User', UserSchema);
const Leave = mongoose.model('Leave', LeaveSchema);
const Justification = mongoose.model('Justification', JustificationSchema);

// ==========================================================
// 2. AUTHENTICATION & SECURITY ROUTES
// ==========================================================

// التسجيل الذاتي للأفراد
app.post('/api/auth/register', async (req, res) => {
    try {
        const { username, password, discord_id } = req.body;
        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = new User({ username, password: hashedPassword, discord_id, role: 'Soldier' });
        await newUser.save();
        res.status(201).json({ msg: "تم التسجيل بنجاح كجندي في عائلة كورتيز." });
    } catch (err) {
        res.status(400).json({ error: "اسم المستخدم مسجل مسبقاً أو البيانات غير صالحة." });
    }
});

// تسجيل الدخول
app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    const user = await User.findOne({ username });
    if (!user || !(await bcrypt.compare(password, user.password))) {
        return res.status(400).json({ error: "خطأ في اسم المستخدم أو كلمة المرور." });
    }
    const token = jwt.sign({ id: user._id, role: user.role, username: user.username }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ token, user: { username: user.username, role: user.role, duty_status: user.duty_status } });
});

// حماية الرتب
const verifyAuth = (roles) => {
    return (req, res, next) => {
        const token = req.headers['authorization']?.split(' ')[1];
        if (!token) return res.status(401).json({ error: "غير مصرح." });
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            if (!roles.includes(decoded.role) && decoded.role !== 'Don') return res.status(403).json({ error: "رتبتك لا تسمح بالدخول." });
            req.user = decoded;
            next();
        } catch { res.status(400).json({ error: "توكن غير صالح." }); }
    }
};

// ==========================================================
// 3. LOGIC & LEADERBOARDS
// ==========================================================

// جلب لوحة المتصدرين والخاملين
app.get('/api/stats/leaderboard', async (req, res) => {
    const allUsers = await User.find({}, 'username weekly_hours role duty_status');
    const usersFormatted = allUsers.map(u => ({
        username: u.username,
        role: u.role,
        duty_status: u.duty_status,
        hours: (u.weekly_hours / 60).toFixed(2)
    }));
    
    const leaderboard = [...usersFormatted].sort((a, b) => b.hours - a.hours);
    const slacking = usersFormatted.filter(u => parseFloat(u.hours) < 10);

    res.json({ leaderboard, slacking });
});

// تقديم طلب إجازة
app.post('/api/hr/leave', verifyAuth(['Soldier', 'HR_Manager']), async (req, res) => {
    const { reason, duration } = req.body;
    const leave = new Leave({ username: req.user.username, reason, duration });
    await leave.save();
    res.json({ msg: "تم رفع طلب الإجازة بنجاح." });
});

// تقديم تبرير غياب
app.post('/api/hr/justify', verifyAuth(['Soldier', 'HR_Manager']), async (req, res) => {
    const { reason } = req.body;
    const justification = new Justification({ username: req.user.username, reason });
    await justification.save();
    res.json({ msg: "تم رفع تبرير الغياب بنجاح." });
});

// جلب طلبات الـ HR (للبوس والـ HR Manager)
app.get('/api/hr/requests', verifyAuth(['HR_Manager']), async (req, res) => {
    const leaves = await Leave.find({ status: 'Pending' });
    const justifications = await Justification.find({ status: 'Pending' });
    res.json({ leaves, justifications });
});

// معالجة الطلبات بالقبول أو الرفض
app.post('/api/hr/action', verifyAuth(['HR_Manager']), async (req, res) => {
    const { type, id, action } = req.body;
    if (type === 'leave') await Leave.findByIdAndUpdate(id, { status: action });
    if (type === 'justify') await Justification.findByIdAndUpdate(id, { status: action });
    res.json({ msg: "تم تحديث حالة الطلب فوراً." });
});

// ==========================================================
// 4. REAL-TIME CORE (SOCKET.IO PUNCH CLOCK)
// ==========================================================

io.on('connection', (socket) => {
    socket.on('toggleDuty', async (data) => {
        const user = await User.findOne({ username: data.username });
        if (!user) return;

        const now = new Date();
        if (user.duty_status === 'OFF-DUTY') {
            user.duty_status = 'ON-DUTY';
            user.last_punch_in = now;
        } else {
            if (user.last_punch_in) {
                const diffMs = now - user.last_punch_in;
                const diffMins = Math.floor(diffMs / 1000 / 60);
                user.weekly_hours += diffMins;
            }
            user.duty_status = 'OFF-DUTY';
        }
        await user.save();

        io.emit('dutyUpdated');
        socket.emit('statusResponse', { duty_status: user.duty_status });
    });
});

server.listen(PORT, () => console.log(`📡 Cortez Mafia System running on port ${PORT}`));
