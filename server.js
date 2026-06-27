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

mongoose.connect(MONGO_URI)
  .then(() => console.log('✓ Connected Strictly to Cortez DB (Stable v5.1).'))
  .catch(err => console.error('❌ Database Error:', err));

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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

const LeaveSchema = new mongoose.Schema({ username: String, reason: String, duration: Number, status: { type: String, default: 'Pending' }, timestamp: { type: Date, default: Date.now } });
const JustificationSchema = new mongoose.Schema({ username: String, reason: String, status: { type: String, default: 'Pending' }, timestamp: { type: Date, default: Date.now } });
const PenaltyLogSchema = new mongoose.Schema({ target_username: String, admin_username: String, type: String, reason: String, timestamp: { type: Date, default: Date.now } });

const User = mongoose.model('User', UserSchema);
const Leave = mongoose.model('Leave', LeaveSchema);
const Justification = mongoose.model('Justification', JustificationSchema);
const PenaltyLog = mongoose.model('PenaltyLog', PenaltyLogSchema);

// Auth
app.post('/api/auth/register', async (req, res) => {
    try {
        const { username, password, discord_id } = req.body;
        if (!discord_id) return res.status(400).json({ error: "حقل الـ Discord ID مطلوب." });
        const hashedPassword = await bcrypt.hash(password, 10);
        const isFirstUser = (await User.countDocuments({})) === 0;
        const newUser = new User({ username, password: hashedPassword, discord_id: String(discord_id), role: isFirstUser ? 'Don' : 'Soldier' });
        await newUser.save();
        res.status(201).json({ msg: `تم التسجيل بنجاح.` });
    } catch (err) { res.status(400).json({ error: "اسم المستخدم مسجل مسبقاً." }); }
});

app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    const user = await User.findOne({ username });
    if (!user || !(await bcrypt.compare(password, user.password))) return res.status(400).json({ error: "خطأ في اسم المستخدم أو كلمة المرور." });
    if (user.is_blacklisted) return res.status(403).json({ error: "تم حظرك ومطاردتك من عائلة كورتيز (بلاك ليست)." });
    const token = jwt.sign({ id: user._id, role: user.role, username: user.username }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ token, user: { username: user.username, role: user.role, duty_status: user.duty_status } });
});

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

// Admin & HR
app.get('/api/admin/users', verifyAuth(['HR_Manager']), async (req, res) => {
    const users = await User.find({}, 'username role duty_status weekly_hours warnings is_blacklisted');
    res.json(users);
});

app.post('/api/admin/change-role', verifyAuth([]), async (req, res) => {
    const { target_username, new_role } = req.body;
    await User.findOneAndUpdate({ username: target_username }, { role: new_role });
    io.emit('dutyUpdated', {}); res.json({ msg: `تم تحديث الرتبة.` });
});

app.post('/api/admin/reset-weekly-hours', verifyAuth([]), async (req, res) => {
    await User.updateMany({}, { weekly_hours: 0, duty_status: 'OFF-DUTY' });
    io.emit('dutyUpdated', {}); res.json({ msg: "تم تصفير الساعات الأسبوعية بنجاح." });
});

app.post('/api/admin/penalty', verifyAuth(['HR_Manager']), async (req, res) => {
    const { target_username, type, reason } = req.body;
    const user = await User.findOne({ username: target_username });
    if (!user) return res.status(404).json({ error: "المستخدم غير موجود." });

    if (type === 'Warning') {
        user.warnings += 1;
        if (user.warnings >= 3) user.is_blacklisted = true;
    } else if (type === 'Blacklist') {
        user.is_blacklisted = true; user.duty_status = 'OFF-DUTY';
    } else if (type === 'Remove_Blacklist') {
        user.is_blacklisted = false; user.warnings = 0;
    }
    await user.save();
    await new PenaltyLog({ target_username, admin_username: req.user.username, type, reason }).save();
    io.emit('dutyUpdated', { username: user.username, duty_status: user.duty_status });
    res.json({ msg: "تم تطبيق العقوبة." });
});

app.get('/api/stats/leaderboard', async (req, res) => {
    const users = await User.find({ is_blacklisted: false }, 'username weekly_hours role duty_status');
    const fmt = users.map(u => ({ username: u.username, role: u.role, duty_status: u.duty_status, hours: u.weekly_hours }));
    res.json({ leaderboard: [...fmt].sort((a,b)=> b.hours - a.hours), slacking: fmt.filter(u=> u.hours < 600) });
});

app.post('/api/hr/leave', verifyAuth(['Soldier', 'HR_Manager']), async (req, res) => {
    await new Leave({ username: req.user.username, reason: req.body.reason, duration: req.body.duration }).save();
    io.emit('requestUpdated'); res.json({ msg: "تم رفع طلب الإجازة بنجاح." });
});

app.post('/api/hr/justify', verifyAuth(['Soldier', 'HR_Manager']), async (req, res) => {
    await new Justification({ username: req.user.username, reason: req.body.reason }).save();
    io.emit('requestUpdated'); res.json({ msg: "تم رفع تبرير الغياب بنجاح." });
});

app.get('/api/hr/requests', verifyAuth(['HR_Manager']), async (req, res) => {
    const leaves = await Leave.find({ status: 'Pending' });
    const justifications = await Justification.find({ status: 'Pending' });
    res.json({ leaves, justifications });
});

app.post('/api/hr/action', verifyAuth(['HR_Manager']), async (req, res) => {
    const { type, id, action } = req.body;
    if (type === 'leave') await Leave.findByIdAndUpdate(id, { status: action });
    if (type === 'justify') await Justification.findByIdAndUpdate(id, { status: action });
    io.emit('requestUpdated'); res.json({ msg: "تم تحديث حالة الطلب." });
});

// Sockets
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
});

server.listen(PORT, () => console.log(`📡 Cortez System v5.1 running on port ${PORT}`));
