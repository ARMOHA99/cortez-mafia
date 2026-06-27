// ==========================================================
// CORTEZ MAFIA - SYSTEM BACKEND (v5.1 SUPERIOR LIVE EDITION)
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

// الرابط السحابي الخاص بك على MongoDB Atlas
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://moha:cutureire@cluster0.qgk83qz.mongodb.net/cortez?appName=Cluster0';

mongoose.connect(MONGO_URI)
  .then(() => console.log('✓ Connected Strictly to Cortez DB.'))
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
    warnings: { type: Number, default: 0 }, // نظام الإنذارات الجديد (0 من 3)
    is_blacklisted: { type: Boolean, default: false } // البلاك ليست
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

// نموذج نظام العقوبات الجديد
const PenaltyLogSchema = new mongoose.Schema({
    target_username: String,
    admin_username: String,
    type: { type: String, enum: ['Warning', 'Blacklist', 'Remove_Blacklist'] },
    reason: String,
    timestamp: { type: Date, default: Date.now }
});

const User = mongoose.model('User', UserSchema);
const Leave = mongoose.model('Leave', LeaveSchema);
const Justification = mongoose.model('Justification', JustificationSchema);
const PenaltyLog = mongoose.model('PenaltyLog', PenaltyLogSchema);

// ==========================================================
// 2. AUTHENTICATION & SECURITY ROUTES
// ==========================================================

// التسجيل الذاتي للأفراد
app.post('/api/auth/register', async (req, res) => {
    try {
        const { username, password, discord_id, discordId } = req.body;
        const finalDiscordId = discord_id || discordId;
        
        if (!finalDiscordId) {
            return res.status(400).json({ error: "حقل الـ Discord ID مطلوب وصالح." });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const isFirstUser = (await User.countDocuments({})) === 0;
        const assignedRole = isFirstUser ? 'Don' : 'Soldier';

        const newUser = new User({ 
            username, 
            password: hashedPassword, 
            discord_id: String(finalDiscordId),
            role: assignedRole 
        });
        
        await newUser.save();
        res.status(201).json({ msg: `تم التسجيل بنجاح برتبة ${assignedRole} في عائلة كورتيز.` });
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
    if (user.is_blacklisted) {
        return res.status(403).json({ error: "تم حظرك ومطاردتك من عائلة كورتيز (بلاك ليست)." });
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
// 3. DON & HR MANAGEMENT ROUTES (الميزات الجديدة)
// ==========================================================

// جلب قائمة كافة الأعضاء لإدارتهم من قبل الـ Don والـ HR
app.get('/api/admin/users', verifyAuth(['HR_Manager']), async (req, res) => {
    const users = await User.find({}, 'username role duty_status weekly_hours warnings is_blacklisted');
    res.json(users);
});

// تغيير رتبة عضو (خاص بالـ Don فقط)
app.post('/api/admin/change-role', verifyAuth([]), async (req, res) => {
    const { target_username, new_role } = req.body;
    if (new_role === 'Don') return res.status(403).json({ error: "لا يمكن تعيين Don آخر بهذه الطريقة." });
    await User.findOneAndUpdate({ username: target_username }, { role: new_role });
    
    // إرسال تحديث فوري لجميع المتصفحات لتحديث الجداول بعد تغيير الرتبة
    io.emit('dutyUpdated', {});
    
    res.json({ msg: `تم تحديث رتبة ${target_username} بنجاح إلى ${new_role}.` });
});

// تصفير ساعات السيرفر الأسبوعية بالكامل (خاص بالـ Don فقط)
app.post('/api/admin/reset-weekly-hours', verifyAuth([]), async (req, res) => {
    await User.updateMany({}, { weekly_hours: 0 });
    
    // تحديث فوري للجميع بعد التصفير
    io.emit('dutyUpdated', {});
    
    res.json({ msg: "تم تصفير الساعات الأسبوعية لجميع أفراد العائلة بنجاح." });
});

// نظام العقوبات: إعطاء إنذار أو إدراج في البلاك ليست
app.post('/api/admin/penalty', verifyAuth(['HR_Manager']), async (req, res) => {
    const { target_username, type, reason } = req.body;
    const user = await User.findOne({ username: target_username });
    if (!user) return res.status(404).json({ error: "المستخدم غير موجود." });

    if (type === 'Warning') {
        user.warnings += 1;
        if (user.warnings >= 3) {
            user.is_blacklisted = true; // نفي تلقائي عند الوصول لـ 3 إنذارات
        }
    } else if (type === 'Blacklist') {
        user.is_blacklisted = true;
        user.duty_status = 'OFF-DUTY';
    } else if (type === 'Remove_Blacklist') {
        user.is_blacklisted = false;
        user.warnings = 0;
    }

    await user.save();
    const log = new PenaltyLog({ target_username, admin_username: req.user.username, type, reason });
    await log.save();

    // تحديث فوري للجميع لتطبيق الحظر أو الإنذار فوراً في اللوحات المفتوحة
    io.emit('dutyUpdated', { username: user.username, duty_status: user.duty_status });

    res.json({ msg: "تم تطبيق العقوبة وتسجيلها في السجلات الرسمية كورتيز." });
});

// ==========================================================
// 4. LOGIC & LEADERBOARDS
// ==========================================================

app.get('/api/stats/leaderboard', async (req, res) => {
    const allUsers = await User.find({ is_blacklisted: false }, 'username weekly_hours role duty_status');
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

app.post('/api/hr/leave', verifyAuth(['Soldier', 'HR_Manager']), async (req, res) => {
    const { reason, duration } = req.body;
    const leave = new Leave({ username: req.user.username, reason, duration });
    await leave.save();
    
    // بث حدث فوري للإدارة بأن هناك طلب إجازة جديد ظهر
    io.emit('requestUpdated');
    
    res.json({ msg: "تم رفع طلب الإجازة بنجاح." });
});

app.post('/api/hr/justify', verifyAuth(['Soldier', 'HR_Manager']), async (req, res) => {
    const { reason } = req.body;
    const justification = new Justification({ username: req.user.username, reason });
    await justification.save();
    
    // بث حدث فوري للإدارة بأن هناك تبرير غياب جديد ظهر
    io.emit('requestUpdated');
    
    res.json({ msg: "تم رفع تبرير الغياب بنجاح." });
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
    
    // بث حدث فوري لتحديث قوائم الإجازات عند القبول أو الرفض تلقائياً للجميع
    io.emit('requestUpdated');
    
    res.json({ msg: "تم تحديث حالة الطلب فوراً." });
});

// ==========================================================
// 5. REAL-TIME CORE (SOCKET.IO PUNCH CLOCK)
// ==========================================================

io.on('connection', (socket) => {
    socket.on('toggleDuty', async (data) => {
        const user = await User.findOne({ username: data.username, is_blacklisted: false });
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

        io.emit('dutyUpdated', { username: user.username, duty_status: user.duty_status });
        socket.emit('statusResponse', { username: user.username, duty_status: user.duty_status });
    });
});

server.listen(PORT, () => console.log(`📡 Cortez Mafia System v5.1 running on port ${PORT}`));
