// ==========================================================
// CORTEZ MAFIA - SERVER BACKEND v6.0 [CYBERPUNK EDITION]
// ==========================================================
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');
const cron = require('node-cron'); // للأرشفة ونظام الـ Anti-AFK
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*" } });

const JWT_SECRET = process.env.JWT_SECRET || "CORTEZ_MAFIA_SECURE_KEY_2026";
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://moha:cutureire@cluster0.qgk83qz.mongodb.net/cortez?appName=Cluster0';

mongoose.connect(MONGO_URI)
  .then(() => console.log('✓ Connected Strictly to Cortez DB v6.'))
  .catch(err => console.error('❌ Database Error:', err));

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================================
// 1. SCHEMAS & MODELS (محدثة بالنظام الجديد)
// ==========================================================

const UserSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    discord_id: { type: String, required: true },
    role: { type: String, enum: ['Don', 'HR_Manager', 'Soldier'], default: 'Soldier' },
    duty_status: { type: String, enum: ['ON-DUTY', 'OFF-DUTY'], default: 'OFF-DUTY' },
    last_punch_in: { type: Date },
    weekly_hours: { type: Number, default: 0 },
    warnings: { type: Number, default: 0 },
    is_blacklisted: { type: Boolean, default: false }
});

const ArchiveSchema = new mongoose.Schema({ // فكرة 4: أرشيف الأسابيع
    week_start: { type: Date, default: Date.now },
    records: Array
});

const LeaveSchema = new mongoose.Schema({ username: String, reason: String, duration: Number, status: { type: String, default: 'Pending' }});
const JustificationSchema = new mongoose.Schema({ username: String, reason: String, status: { type: String, default: 'Pending' }});
const PenaltyLogSchema = new mongoose.Schema({ target_username: String, admin_username: String, type: String, reason: String, timestamp: { type: Date, default: Date.now }});

const User = mongoose.model('User', UserSchema);
const Archive = mongoose.model('Archive', ArchiveSchema);
const Leave = mongoose.model('Leave', LeaveSchema);
const Justification = mongoose.model('Justification', JustificationSchema);
const PenaltyLog = mongoose.model('PenaltyLog', PenaltyLogSchema);

// ==========================================================
// 2. MIDDLEWARE & AUTH
// ==========================================================

const verifyAuth = (roles) => {
    return (req, res, next) => {
        const token = req.headers['authorization']?.split(' ')[1];
        if (!token) return res.status(401).json({ error: "غير مصرح." });
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            if (!roles.includes(decoded.role) && decoded.role !== 'Don') return res.status(403).json({ error: "رتبتك لا تسمح بالدخول." });
            req.user = decoded; next();
        } catch { res.status(400).json({ error: "توكن غير صالح." }); }
    }
};

app.post('/api/auth/register', async (req, res) => {
    try {
        const { username, password, discord_id } = req.body;
        if (!discord_id) return res.status(400).json({ error: "حقل الـ Discord ID مطلوب." });
        const hashedPassword = await bcrypt.hash(password, 10);
        const isFirstUser = (await User.countDocuments({})) === 0;
        const newUser = new User({ username, password: hashedPassword, discord_id, role: isFirstUser ? 'Don' : 'Soldier' });
        await newUser.save();
        res.status(201).json({ msg: `تم التسجيل بنجاح.` });
    } catch (err) { res.status(400).json({ error: "اسم المستخدم مسجل مسبقاً." }); }
});

app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    const user = await User.findOne({ username });
    if (!user || !(await bcrypt.compare(password, user.password))) return res.status(400).json({ error: "بيانات الدخول خاطئة." });
    if (user.is_blacklisted) return res.status(403).json({ error: "تم حظرك ومطاردتك من العائلة." });
    const token = jwt.sign({ id: user._id, role: user.role, username: user.username }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ token, user: { username: user.username, role: user.role, duty_status: user.duty_status } });
});

// ==========================================================
// 3. ADMIN ROUTES (Archiving & Penalties)
// ==========================================================

app.get('/api/admin/users', verifyAuth(['HR_Manager']), async (req, res) => {
    const users = await User.find({}, 'username role duty_status weekly_hours warnings is_blacklisted');
    res.json(users);
});

app.post('/api/admin/change-role', verifyAuth([]), async (req, res) => {
    const { target_username, new_role } = req.body;
    await User.findOneAndUpdate({ username: target_username }, { role: new_role });
    io.emit('dutyUpdated', {}); res.json({ msg: `تم تحديث الرتبة.` });
});

// أرشفة وتصفير الساعات (فكرة 4)
app.post('/api/admin/reset-weekly-hours', verifyAuth([]), async (req, res) => {
    const allUsers = await User.find({}, 'username weekly_hours role');
    const archive = new Archive({ records: allUsers });
    await archive.save(); // حفظ نسخة من الساعات قبل التصفير
    await User.updateMany({}, { weekly_hours: 0, duty_status: 'OFF-DUTY' });
    io.emit('dutyUpdated', {}); res.json({ msg: "تمت الأرشفة وتصفير الساعات بنجاح." });
});

// ==========================================================
// 4. LEADERBOARD & HR
// ==========================================================

app.get('/api/stats/leaderboard', async (req, res) => {
    const users = await User.find({ is_blacklisted: false }, 'username weekly_hours role duty_status');
    const fmt = users.map(u => ({ username: u.username, role: u.role, duty_status: u.duty_status, hours: u.weekly_hours }));
    res.json({ leaderboard: [...fmt].sort((a,b)=> b.hours - a.hours), slacking: fmt.filter(u=> u.hours < 600) });
});

// HR Routes ... (مختصرة لتوفير المساحة، وهي نفسها تماماً من النسخة السابقة)
app.post('/api/hr/leave', verifyAuth(['Soldier', 'HR_Manager']), async (req, res) => {
    await new Leave({ username: req.user.username, reason: req.body.reason, duration: req.body.duration }).save();
    io.emit('requestUpdated'); res.json({ msg: "تم رفع الإجازة." });
});

// ==========================================================
// 5. LIVE SOCKETS & ANTI-AFK (فكرة 3 و 5)
// ==========================================================

io.on('connection', (socket) => {
    socket.on('toggleDuty', async (data) => {
        const user = await User.findOne({ username: data.username, is_blacklisted: false });
        if (!user) return;
        const now = new Date();
        if (user.duty_status === 'OFF-DUTY') {
            user.duty_status = 'ON-DUTY'; user.last_punch_in = now;
        } else {
            if (user.last_punch_in) user.weekly_hours += Math.floor((now - user.last_punch_in) / 60000);
            user.duty_status = 'OFF-DUTY';
        }
        await user.save();
        io.emit('dutyUpdated', { username: user.username, duty_status: user.duty_status });
        socket.emit('statusResponse', { username: user.username, duty_status: user.duty_status });
    });

    // حالة الاستنفار للبوس (فكرة 5)
    socket.on('triggerEmergency', (data) => {
        io.emit('emergencyAlert', { msg: data.msg, time: new Date() });
    });
});

// فكرة 3: Anti-AFK System (يفحص كل ساعة، ويغلق دوام أي شخص مر عليه 8 ساعات دون إيقاف)
cron.schedule('0 * * * *', async () => {
    const maxDutyTimeMs = 8 * 60 * 60 * 1000; // 8 ساعات
    const now = new Date();
    const afkUsers = await User.find({ duty_status: 'ON-DUTY' });
    
    for (let u of afkUsers) {
        if (now - u.last_punch_in > maxDutyTimeMs) {
            u.weekly_hours += Math.floor((now - u.last_punch_in) / 60000);
            u.duty_status = 'OFF-DUTY';
            await u.save();
            io.emit('dutyUpdated', { username: u.username, duty_status: 'OFF-DUTY' });
        }
    }
});

server.listen(PORT, () => console.log(`📡 Cortez Mafia Cyber-Core running on port ${PORT}`));
