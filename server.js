const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');
// لرفع الصور إلى Cloudinary — التثبيت: npm install multer cloudinary multer-storage-cloudinary
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: process.env.CORS_ORIGIN || "http://localhost:3000" } });

const JWT_SECRET = process.env.JWT_SECRET || 'CORTEZ_MAFIA_SECURE_KEY_2026';
const PORT = process.env.PORT || 3000;

// الاتصال بقاعدة بيانات MongoDB
const MONGO_URI = process.env.MONGO_URI;

if (!MONGO_URI) { console.error('MONGO_URI غير معرف. يرجى ضبط متغير البيئة MONGO_URI.'); process.exit(1); }
mongoose.connect(MONGO_URI)
  .then(() => console.log('تم الاتصال بقاعدة بيانات CORTEZ (v8.0 - الملاحظات والحضور والمخزون).'))
  .catch(err => console.error('خطأ في الاتصال بقاعدة البيانات:', err));

app.use(cors({ origin: process.env.CORS_ORIGIN || "http://localhost:3000" }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ================== إعداد Cloudinary لرفع الصور (يُستخدم مع Render عبر متغيرات البيئة) ==================
// المتغيرات يجب ضبطها في Environment Variables داخل Render (أو أي استضافة أخرى)
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

const imageStorage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: {
        folder: 'cortez-uploads',
        allowed_formats: ['jpg', 'jpeg', 'png', 'gif', 'webp']
    }
});

const imageUpload = multer({
    storage: imageStorage,
    limits: { fileSize: 5 * 1024 * 1024 }
});

// ================== دوال التنسيق المالية ==================
// ---------------- تنسيق قصير (M / K) ----------------
const formatMoneyShort = (amount) => {
    if (!amount) return '0';
    const num = Number(amount);
    if (num >= 1000000) return (num / 1000000).toFixed(2).replace(/\.00$/, '') + 'M';
    if (num >= 1000) return (num / 1000).toFixed(2).replace(/\.00$/, '') + 'K';
    return num.toString();
};

const formatMoneyExact = (amount) => {
    if (!amount) return '0';
    return Number(amount).toLocaleString('en-US');
};

// ================== v8.0: التحقق من نافذة الدوام المسموحة (22:00 - 04:00 بتوقيت الجزائر CET/UTC+1) ==================
function isInDutyTimeWindow() {
    const now = new Date();
    // حساب الوقت الحالي بتوقيت الجزائر (CET = UTC+1)
    const dzTime = new Date(now.getTime() + (60 * 60 * 1000));
    const hours = dzTime.getUTCHours();
    const minutes = dzTime.getUTCMinutes();
    const totalMinutes = hours * 60 + minutes;
    // النافذة: من 22:00 (1320 دقيقة) حتى 04:00 (240 دقيقة)
    // أي من 22:00 (1320) إلى 23:59 (1439) أو من 00:00 (0) إلى 04:00 (240)
    return totalMinutes >= 1320 || totalMinutes <= 240;
}

// ================== v8.0: نافذة يوم دوام واحد (من 22:00 حتى 04:00 بتوقيت الجزائر) ==================
// تُحسب عبر Date.UTC فقط لتبقى صحيحة مهما كان توقيت جهاز السيرفر (22:00 الجزائر = 21:00 UTC)
function getDutyDayWindow(offsetDays) {
    const dzNow = new Date(Date.now() + 60 * 60 * 1000);
    const start = new Date(Date.UTC(
        dzNow.getUTCFullYear(),
        dzNow.getUTCMonth(),
        dzNow.getUTCDate() + offsetDays,
        21, 0, 0, 0
    ));
    const end = new Date(start.getTime() + 6 * 60 * 60 * 1000); // 04:00 بتوقيت الجزائر
    return { start, end };
}

// ================== v8.0: نص ملاحظة الغياب التلقائي لعدم تفعيل ON-DUTY ==================
const MISSED_DUTY_NOTE_TEXT = "غاب عن الدوام - لم يسجل ON-DUTY خلال الفترة المسموحة (22:00 - 04:00 بتوقيت الجزائر)";

// ---------------- المخططات (Schemas) ----------------
const UserSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    discord_id: { type: String, required: true },
    role: { type: String, enum: ['Don', 'Underboss', 'Capo', 'Business_Manager', 'Chef_Braquage', 'GRH', 'Soldat', 'Gang_Supervisor', 'Gang_Member'], default: 'Soldat' },
    // اسم عصابة عضو العصابة (يُستخدم لأعضاء العصابات فقط)
    gang_name: { type: String, default: '' },
    account_status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'approved' },
    duty_status: { type: String, enum: ['ON-DUTY', 'OFF-DUTY'], default: 'OFF-DUTY' },
    last_punch_in: { type: Date },
    weekly_hours: { type: Number, default: 0 },
    warnings: { type: Number, default: 0 },
    // سجل تواريخ الإنذارات (يُستخدم لحساب انتهاء صلاحية الإنذار بعد 30 يوماً)
    warning_dates: { type: [Date], default: [] },
    is_blacklisted: { type: Boolean, default: false },
    consecutive_misses: { type: Number, default: 0 },
    total_heists: { type: Number, default: 0 },
    // v7.7: الغرامات المالية المستحقة
    fine_amount: { type: Number, default: 0 },
    fine_reason: { type: String, default: "" }
});

const LeaveSchema = new mongoose.Schema({ username: String, reason: String, duration: Number, status: { type: String, default: 'Pending' }, timestamp: { type: Date, default: Date.now } });
const JustificationSchema = new mongoose.Schema({ username: String, reason: String, status: { type: String, default: 'Pending' }, timestamp: { type: Date, default: Date.now } });
const PenaltyLogSchema = new mongoose.Schema({ target_username: String, admin_username: String, type: String, reason: String, fine_amount: { type: Number, default: 0 }, timestamp: { type: Date, default: Date.now } });

const ArchiveSchema = new mongoose.Schema({ week_date: { type: Date, default: Date.now }, records: Array });

const ItemSchema = new mongoose.Schema({
    name: { type: String, required: true },
    price: { type: Number, required: true },
    image_url: { type: String, default: 'https://placehold.co/150x150/0d0d0d/00ff66?text=Item' },
    // حالة توفر المنتج
    in_stock: { type: Boolean, default: true },
    max_per_order: { type: Number, default: null }, // null = بدون حد للطلب
    max_per_week: { type: Number, default: null },  // null = بدون حد أسبوعي
    created_by: String,
    timestamp: { type: Date, default: Date.now }
});

const OrderSchema = new mongoose.Schema({
    username: String,
    item_name: String,
    price: Number,
    items: Array,
    total_price: Number,
    status: { type: String, enum: ['Pending', 'Paid', 'Rejected'], default: 'Pending' },
    timestamp: { type: Date, default: Date.now }
});

const TreasurySchema = new mongoose.Schema({ total_balance: { type: Number, default: 0 } });

const HeistTypeSchema = new mongoose.Schema({ name: { type: String, required: true, unique: true } });
const HeistItemSchema = new mongoose.Schema({ name: { type: String, required: true, unique: true }, price: { type: Number, required: true, default: 0 } });
const WeeklyGoalSchema = new mongoose.Schema({
    target_amount: { type: Number, default: 0 },
    payout_percentage: { type: Number, default: 0 },
    current_progress: { type: Number, default: 0 },
    is_visible: { type: Boolean, default: false }
});

const HeistLogSchema = new mongoose.Schema({
    chef_name: String,
    heist_type: String,
    status: { type: String, enum: ['Win', 'Loss'] },
    participants: [String],
    cash_amount: Number,
    loss_amount: Number,
    items: Array,
    total_value: Number,
    timestamp: { type: Date, default: Date.now }
});

// ================== مخطط تتبع العصابات (يُحتفظ به للتوافق مع الإصدارات السابقة) ==================
const GangSchema = new mongoose.Schema({
    name: { type: String, required: true },
    radio_frequency: { type: String, default: '' },
    loyalty_percentage: { type: Number, default: 50, min: 0, max: 100 },
    map_x: { type: Number, required: true },
    map_y: { type: Number, required: true },
    notes: { type: String, default: '' },
    created_by: String,
    updated_by: String,
    timestamp: { type: Date, default: Date.now },
    updated_at: { type: Date, default: Date.now }
});

const User = mongoose.model('User', UserSchema);
const Leave = mongoose.model('Leave', LeaveSchema);
const Justification = mongoose.model('Justification', JustificationSchema);
const PenaltyLog = mongoose.model('PenaltyLog', PenaltyLogSchema);
const Archive = mongoose.model('Archive', ArchiveSchema);
const Item = mongoose.model('Item', ItemSchema);
const Order = mongoose.model('Order', OrderSchema);
const Treasury = mongoose.model('Treasury', TreasurySchema);

const HeistType = mongoose.model('HeistType', HeistTypeSchema);
const HeistItem = mongoose.model('HeistItem', HeistItemSchema);
const WeeklyGoal = mongoose.model('WeeklyGoal', WeeklyGoalSchema);
const HeistLog = mongoose.model('HeistLog', HeistLogSchema);
const Gang = mongoose.model('Gang', GangSchema);

// ================== v8.0: مخطط الملاحظات ==================
const MemberNoteSchema = new mongoose.Schema({
    username: String,
    reason: String,
    issued_by: String,
    bill_amount: { type: Number, default: 0 },
    is_auto: { type: Boolean, default: false },
    timestamp: { type: Date, default: Date.now }
});

// ================== v8.0: مخطط أصناف المخزون (حاسبة البزنس مانجر) ==================
const InventoryItemSchema = new mongoose.Schema({
    name: { type: String, required: true },
    image_url: { type: String, default: 'https://placehold.co/150x150/0d0d0d/00ff66?text=Item' },
    buy_from_gang_price: { type: Number, default: 0 },
    sell_to_black_price: { type: Number, default: 0 },
    quantity: { type: Number, default: 0 },
    created_by: String,
    timestamp: { type: Date, default: Date.now }
});

const MemberNote = mongoose.model('MemberNote', MemberNoteSchema);
const InventoryItem = mongoose.model('InventoryItem', InventoryItemSchema);

// ================== مخطط عناصر شوب العصابات (تبادل مع المافيا) ==================
const GangShopItemSchema = new mongoose.Schema({
    name: { type: String, required: true },
    item_type: { type: String, enum: ['buy_only', 'sell_only', 'both'], default: 'both' },
    buy_price: { type: Number, default: null },
    sell_price: { type: Number, default: null },
    in_stock: { type: Boolean, default: true },
    max_per_order: { type: Number, default: null },
    max_per_week: { type: Number, default: null },
    image_url: { type: String, default: 'https://placehold.co/150x150/1a1a1a/ffaa00?text=Item' },
    created_by: String,
    timestamp: { type: Date, default: Date.now }
});

const GangOrderSchema = new mongoose.Schema({
    gang_member_username: String,
    gang_name: String,
    items_bought: { type: Array, default: [] },
    items_sold: { type: Array, default: [] },
    total_buy_value: { type: Number, default: 0 },
    total_sell_value: { type: Number, default: 0 },
    net_amount: { type: Number, default: 0 },
    status: { type: String, enum: ['Pending', 'Confirmed', 'Rejected', 'Cancelled'], default: 'Pending' },
    rejection_reason: { type: String, default: '' },
    timestamp: { type: Date, default: Date.now }
});

const GangTreasurySchema = new mongoose.Schema({ total_balance: { type: Number, default: 0 } });

// ================== تتبع المشتريات الأسبوعية (لتطبيق حدود "X في الأسبوع") ==================
const WeeklyPurchaseSchema = new mongoose.Schema({
    username: String,
    item_name: String,
    shop_type: { type: String, enum: ['weapon_shop', 'gang_shop'] },
    quantity_bought: { type: Number, default: 0 }
});

// ================== سجل التدقيق (Audit Log) للأحداث الإدارية المهمة ==================
const AuditLogSchema = new mongoose.Schema({
    action: String,
    target_username: String,
    performed_by: String,
    details: { type: String, default: '' },
    timestamp: { type: Date, default: Date.now }
});

// ================== سجل بصمات الدخول/الخروج (أساس نظام الحضور الصحيح) ==================
const PunchRecordSchema = new mongoose.Schema({
    username: { type: String, required: true },
    action: { type: String, enum: ['IN', 'OUT'], required: true },
    timestamp: { type: Date, default: Date.now }
});
PunchRecordSchema.index({ username: 1, timestamp: 1 });

const GangShopItem = mongoose.model('GangShopItem', GangShopItemSchema);
const GangOrder = mongoose.model('GangOrder', GangOrderSchema);
const GangTreasury = mongoose.model('GangTreasury', GangTreasurySchema);
const WeeklyPurchase = mongoose.model('WeeklyPurchase', WeeklyPurchaseSchema);
const AuditLog = mongoose.model('AuditLog', AuditLogSchema);
const PunchRecord = mongoose.model('PunchRecord', PunchRecordSchema);

// ================== v8.1: نظام بطولة Champion Cup ==================
const MatchSchema = new mongoose.Schema({
    tournamentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tournament' },
    stage: { type: String, enum: ['group', 'semifinal', 'final'], required: true },
    groupNumber: Number,
    gangA: { type: mongoose.Schema.Types.ObjectId, ref: 'Gang' },
    gangB: { type: mongoose.Schema.Types.ObjectId, ref: 'Gang' },
    scheduledAt: Date,
    weapons: { type: [String], default: [] },
    status: { type: String, enum: ['scheduled', 'completed'], default: 'scheduled' },
    result: {
        scoreA: Number,
        scoreB: Number,
        winner: { type: mongoose.Schema.Types.ObjectId, ref: 'Gang' },
        notes: { type: String, default: '' },
        recordedBy: String,
        recordedAt: Date
    }
});

const TournamentSchema = new mongoose.Schema({
    name: { type: String, default: () => `Champion Cup #${Date.now()}` },
    status: { type: String, enum: ['setup', 'ongoing', 'completed', 'cancelled'], default: 'setup' },
    gangs: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Gang' }],
    groups: [{
        groupNumber: Number,
        gangs: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Gang' }],
        matchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Match' }
    }],
    semiFinals: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Match' }],
    final: { type: mongoose.Schema.Types.ObjectId, ref: 'Match' },
    prizePool: [{
        shopItemId: { type: mongoose.Schema.Types.ObjectId, ref: 'Item' },
        name: String,
        image: String,
        price: Number,
        quantity: Number
    }],
    champion: { type: mongoose.Schema.Types.ObjectId, ref: 'Gang' },
    distributedAt: Date,
    createdBy: String,
    createdAt: { type: Date, default: Date.now },
    completedAt: Date
});

const Match = mongoose.model('Match', MatchSchema);
const Tournament = mongoose.model('Tournament', TournamentSchema);

async function initSystemDB() {
    try {
        const treasuryCount = await Treasury.countDocuments({});
        if (treasuryCount === 0) { await new Treasury({ total_balance: 0 }).save(); }

        // خزينة شوب العصابات
        const gangTreasuryCount = await GangTreasury.countDocuments({});
        if (gangTreasuryCount === 0) { await new GangTreasury({ total_balance: 0 }).save(); }
    } catch (err) {
        console.error("Initialization warning:", err.message);
    }
}
initSystemDB();

// ================== إدارة اتصالات السوكيت الخاصة بالمستخدمين (لتفعيل الطرد الفوري) ==================
const userSockets = {}; // { username: [socketId, ...] }
const socketUsers = {}; // { socketId: username } — للتحقق الأمني من هوية السوكيت

// ---------------- دالة المصادقة والصلاحيات ----------------
const verifyAuth = (roles) => {
    return (req, res, next) => {
        const token = req.headers['authorization']?.split(' ')[1];
        if (!token) return res.status(401).json({ error: "لم يتم إرسال رمز التوكن." });
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            req.user = decoded;
            // التحقق من الحالة الحالية للمستخدم (محظور / بانتظار الموافقة / الرتبة الحالية)
            User.findOne({ username: decoded.username }).select('is_blacklisted role account_status').then(currentUser => {
                if (!currentUser || currentUser.account_status !== 'approved') {
                    return res.status(401).json({ error: "حسابك غير مفعل بعد. يرجى انتظار الموافقة.", forceLogout: true });
                }
                if (currentUser.is_blacklisted) {
                    return res.status(403).json({ error: "أنت محظور من استخدام النظام (قائمة سوداء).", forceLogout: true });
                }
                decoded.role = currentUser.role;
                const hasAccess = roles.includes(decoded.role) || decoded.role === 'Don';
                if (!hasAccess) return res.status(403).json({ error: "ليست لديك صلاحية الوصول لهذه الميزة." });
                next();
            }).catch(() => res.status(500).json({ error: "خطأ في معالجة الطلب." }));
        } catch { res.status(400).json({ error: "انتهت صلاحية التوكن أو أنه غير صالح." }); }
    }
};

// ================== مسارات الواجهة البرمجية ==================

// رفع الصور إلى Cloudinary (متاح للقيادة وأصحاب الصلاحيات فقط)
app.post('/api/upload-image', verifyAuth(['Underboss', 'Business_Manager', 'Gang_Supervisor', 'Don']), (req, res) => {
    imageUpload.single('image')(req, res, (err) => {
        if (err) return res.status(400).json({ error: err.message || "خطأ في رفع الصورة." });
        if (!req.file) return res.status(400).json({ error: "لم يتم العثور على الصورة المرفوعة." });
        res.json({ url: req.file.path });
    });
});

app.post('/api/auth/register', async (req, res) => {
    try {
        const { username, password, discord_id } = req.body;
        if (!discord_id) return res.status(400).json({ error: "يجب إدخال Discord ID." });
        const hashedPassword = await bcrypt.hash(password, 10);
        const isFirstUser = (await User.countDocuments({})) === 0;
        const newUser = new User({
            username, password: hashedPassword, discord_id: String(discord_id),
            role: isFirstUser ? 'Don' : 'Soldat',
            account_status: isFirstUser ? 'approved' : 'pending'
        });
        await newUser.save();
        if (!isFirstUser) io.emit('accountPending');
        res.status(201).json({ msg: isFirstUser ? "تم إنشاء الحساب بنجاح." : "تم إرسال طلب الحساب. يرجى انتظار موافقة القيادة العليا." });
    } catch (err) { res.status(400).json({ error: "خطأ في التسجيل: اسم المستخدم مستخدم مسبقاً." }); }
});

// ================== تسجيل حساب عضو عصابة (تتم الموافقة عليه من GRH أو الدون) ==================
app.post('/api/gang-auth/register', async (req, res) => {
    try {
        const { username, password, gang_name, discord_id } = req.body;
        if (!username || !password || !gang_name) return res.status(400).json({ error: "يجب تعبئة اسم المستخدم وكلمة المرور واسم العصابة." });

        const existing = await User.findOne({ username });
        if (existing) return res.status(400).json({ error: "اسم المستخدم مستخدم مسبقاً." });

        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = new User({
            username, password: hashedPassword, discord_id: discord_id ? String(discord_id) : 'N/A',
            role: 'Gang_Member', gang_name, account_status: 'pending'
        });
        await newUser.save();
        io.emit('accountPending');
        res.status(201).json({ msg: "تم إرسال طلب حساب العصابة. يرجى انتظار الموافقة من الإدارة." });
    } catch (err) { res.status(400).json({ error: "خطأ في إنشاء حساب العصابة." }); }
});

// قائمة أسماء العصابات المسجلة (اقتراحات أثناء التسجيل)
app.get('/api/gangs', async (req, res) => {
    try {
        const gangs = await User.distinct('gang_name', { gang_name: { $ne: '' } });
        res.json(gangs.map(name => ({ name })));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const user = await User.findOne({ username });
        if (!user || !(await bcrypt.compare(password, user.password))) return res.status(400).json({ error: "اسم المستخدم أو كلمة المرور غير صحيحة." });
        if (user.is_blacklisted) return res.status(403).json({ error: "أنت محظور من استخدام النظام (قائمة سوداء)." });

        if (user.account_status === 'pending') return res.status(403).json({ error: "حسابك لم تتم الموافقة عليه بعد. يرجى الانتظار." });
        if (user.account_status === 'rejected') return res.status(403).json({ error: "تم رفض حسابك من قبل الإدارة." });
        
        const token = jwt.sign({ id: user._id, role: user.role, username: user.username }, JWT_SECRET, { expiresIn: '24h' });
        res.json({ token, user: { username: user.username, role: user.role, gang_name: user.gang_name, duty_status: user.duty_status, fine_amount: user.fine_amount, fine_reason: user.fine_reason } });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/auth/me', async (req, res) => {
    try {
        const token = req.headers['authorization']?.split(' ')[1];
        if (!token) return res.status(401).json({ error: "غير مصرح" });
        const decoded = jwt.verify(token, JWT_SECRET);
        const user = await User.findById(decoded.id, 'username role duty_status fine_amount fine_reason');
        if (!user) return res.status(401).json({ error: "حسابك لم يعد موجوداً", forceLogout: true });
        res.json(user);
    } catch { res.status(401).json({ error: "انتهت الجلسة" }); }
});

app.get('/api/users/list', verifyAuth(['Underboss', 'Chef_Braquage', 'Business_Manager', 'Don']), async (req, res) => {
    try {
        const users = await User.find({ is_blacklisted: false, account_status: 'approved', role: { $ne: 'Gang_Member' } }, 'username');
        res.json(users);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/shop/items', async (req, res) => {
    try { const items = await Item.find().sort({ timestamp: -1 }); res.json(items); } 
    catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/shop/add-item', verifyAuth(['Underboss', 'Business_Manager']), async (req, res) => {
    try {
        const { name, price, image_url, in_stock, max_per_order, max_per_week } = req.body;
        const newItem = new Item({
            name, price: Number(price), image_url, created_by: req.user.username,
            in_stock: in_stock !== undefined ? !!in_stock : true,
            max_per_order: (max_per_order === '' || max_per_order === undefined || max_per_order === null) ? null : Number(max_per_order),
            max_per_week: (max_per_week === '' || max_per_week === undefined || max_per_week === null) ? null : Number(max_per_week)
        });
        await newItem.save();
        io.emit('shopUpdated');
        res.status(201).json({ msg: "تمت إضافة المنتج إلى الشوب بنجاح." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/shop/item/:id', verifyAuth(['Underboss', 'Business_Manager']), async (req, res) => {
    try {
        const { name, price, image_url, in_stock, max_per_order, max_per_week } = req.body;
        const update = {};
        if (name !== undefined) update.name = name;
        if (price !== undefined) update.price = Number(price);
        if (image_url !== undefined) update.image_url = image_url;
        if (in_stock !== undefined) update.in_stock = !!in_stock;
        if (max_per_order !== undefined) update.max_per_order = (max_per_order === '' || max_per_order === null) ? null : Number(max_per_order);
        if (max_per_week !== undefined) update.max_per_week = (max_per_week === '' || max_per_week === null) ? null : Number(max_per_week);
        await Item.findByIdAndUpdate(req.params.id, update);
        io.emit('shopUpdated');
        res.json({ msg: "تم تحديث المنتج بنجاح." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/shop/item/:id', verifyAuth(['Underboss', 'Business_Manager']), async (req, res) => {
    try {
        await Item.findByIdAndDelete(req.params.id);
        io.emit('shopUpdated');
        res.json({ msg: "تم حذف المنتج بنجاح." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/shop/checkout', verifyAuth(['Underboss', 'Soldat', 'Capo', 'GRH', 'Chef_Braquage', 'Business_Manager', 'Gang_Supervisor']), async (req, res) => {
    try {
        const { items } = req.body;
        if (!items || items.length === 0) return res.status(400).json({ error: "السلة فارغة." });

        const username = req.user.username;
        let total_price = 0;
        const processedItems = [];

        for (const i of items) {
            const dbItem = await Item.findOne({ name: i.name });
            if (!dbItem) return res.status(400).json({ error: `المنتج "${i.name}" غير موجود.` });
            if (!dbItem.in_stock) return res.status(400).json({ error: `المنتج "${i.name}" غير متوفر حالياً (نفذت الكمية).` });

            const qty = Math.max(1, parseInt(i.quantity) || 1);
            if (dbItem.max_per_order && qty > dbItem.max_per_order) {
                return res.status(400).json({ error: `الكمية المطلوبة من المنتج "${i.name}" تتجاوز الحد المسموح للطلب (${dbItem.max_per_order} قطع).` });
            }

            if (dbItem.max_per_week) {
                const record = await WeeklyPurchase.findOne({ username, item_name: i.name, shop_type: 'weapon_shop' });
                const alreadyBought = record ? record.quantity_bought : 0;
                if (alreadyBought + qty > dbItem.max_per_week) {
                    const remaining = Math.max(0, dbItem.max_per_week - alreadyBought);
                    return res.status(400).json({ error: `لقد وصلت للحد الأسبوعي للمنتج "${i.name}" (${dbItem.max_per_week} قطع). المتبقي: ${remaining}.` });
                }
            }

            const itemTotal = dbItem.price * qty;
            total_price += itemTotal;
            processedItems.push({ name: dbItem.name, price: dbItem.price, quantity: qty, total: itemTotal, max_per_week: dbItem.max_per_week });
        }

        for (const p of processedItems) {
            if (p.max_per_week) {
                await WeeklyPurchase.updateOne(
                    { username, item_name: p.name, shop_type: 'weapon_shop' },
                    { $inc: { quantity_bought: p.quantity } },
                    { upsert: true }
                );
            }
        }

        const finalItems = processedItems.map(p => ({ name: p.name, price: p.price, quantity: p.quantity, total: p.total }));
        const newOrder = new Order({ username, items: finalItems, total_price, status: 'Pending' });
        await newOrder.save();
        io.emit('ordersUpdated');
        res.json({ msg: "تم إرسال طلب الشراء بنجاح. بانتظار استلام الدفعة من الإدارة." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/shop/orders', verifyAuth(['Don', 'Underboss', 'Business_Manager', 'Chef_Braquage', 'GRH']), async (req, res) => {
    try { const orders = await Order.find().sort({ timestamp: -1 }); res.json(orders); } 
    catch (err) { res.status(500).json({ error: err.message }); }
});

const confirmPaymentLogic = async (req, res) => {
    try {
        const order_id = req.params.id || req.body.order_id;
        if (!order_id) return res.status(400).json({ error: "لم يتم تحديد رقم الطلب." });

        const order = await Order.findById(order_id);
        if (!order || order.status === 'Paid') return res.status(400).json({ error: "الطلب غير موجود أو تم الدفع مسبقاً." });
        
        order.status = 'Paid';
        await order.save();
        
        const amountToAdd = order.total_price || order.price; 
        await Treasury.updateOne({}, { $inc: { total_balance: amountToAdd } });
        
        io.emit('ordersUpdated'); io.emit('treasuryUpdated');
        res.json({ msg: "تم تأكيد استلام المبلغ وإضافته إلى خزينة العصابة بنجاح." });
    } catch (err) { res.status(500).json({ error: err.message }); }
};

app.post('/api/shop/order/:id/pay', verifyAuth(['Don', 'Underboss', 'Business_Manager', 'GRH', 'Chef_Braquage']), confirmPaymentLogic);
app.put('/api/shop/order/:id/pay', verifyAuth(['Don', 'Underboss', 'Business_Manager', 'GRH', 'Chef_Braquage']), confirmPaymentLogic);

// رفض طلب شراء من شوب الأعضاء (لا يُضاف أي مبلغ إلى الخزينة)
app.post('/api/shop/order/:id/reject', verifyAuth(['Don', 'Underboss', 'Business_Manager', 'GRH', 'Chef_Braquage']), async (req, res) => {
    try {
        const order = await Order.findById(req.params.id);
        if (!order || order.status === 'Paid') return res.status(400).json({ error: "الطلب غير موجود أو تم قبضه مسبقاً." });

        order.status = 'Rejected';
        await order.save();
        io.emit('ordersUpdated');
        res.json({ msg: "تم رفض الطلب." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/treasury/balance', verifyAuth(['Underboss', 'Business_Manager']), async (req, res) => {
    try {
        const treasury = await Treasury.findOne({});
        const balance = treasury ? treasury.total_balance : 0;
        res.json({ balance_raw: balance, balance_formatted: formatMoneyShort(balance) });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/treasury/reset', verifyAuth(['Don']), async (req, res) => {
    try {
        await Treasury.updateOne({}, { total_balance: 0 });
        io.emit('treasuryUpdated');
        res.json({ msg: "تم تصفير الخزينة العليا للعصابة بنجاح." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// دالة تهريب النصوص لعرضها بأمان داخل HTML (حماية من XSS)
const escapeHtml = (str) => {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
};

app.get('/api/shop/invoice/:id', async (req, res) => {
    try {
        const order = await Order.findById(req.params.id);
        if (!order) return res.status(404).send("الفاتورة غير موجودة");
        
        let itemsList = '';
        if (order.items && order.items.length > 0) {
            itemsList = order.items.map(i => {
                const qty = i.quantity || 1;
                return `<li>${qty}x ${escapeHtml(i.name)} - ${formatMoneyExact(i.total || (i.price * qty))}$</li>`;
            }).join('');
        } else { itemsList = `<li>1x ${escapeHtml(order.item_name)} - ${formatMoneyExact(order.price)}$</li>`; }

        const total = formatMoneyExact(order.total_price || order.price);
        const html = `
        <html lang="ar" dir="rtl">
        <head>
            <meta charset="UTF-8">
            <title>CORTEZ MAFIA - INVOICE</title>
            <style>
                body { font-family: 'Courier New', monospace; background: #050505; color: #e0e0e0; padding: 40px; text-align: center; }
                .invoice-box { border: 2px solid #00ff66; padding: 40px; max-width: 600px; margin: auto; background: #0a0a0a; box-shadow: 0 0 30px rgba(0,255,102,0.1); }
                h1 { color: #00ff66; margin-bottom: 5px; letter-spacing: 2px; text-transform: uppercase; }
                h3 { color: #555; margin-top: 0; }
                hr { border-color: #222; margin: 30px 0; }
                .details { text-align: right; margin-bottom: 30px; font-size: 1.1rem; line-height: 1.8; }
                .total { font-size: 1.5rem; color: gold; font-weight: bold; border-top: 1px dashed #333; padding-top: 20px; margin-top: 20px;}
                ul { text-align: right; font-size: 1.1rem; list-style: none; padding: 0; }
                li { padding: 8px 0; border-bottom: 1px solid #111; }
                .stamp { color: #00ff66; border: 2px solid #00ff66; display: inline-block; padding: 10px 20px; transform: rotate(-10deg); font-weight: bold; margin-top: 30px; }
            </style>
        </head>
        <body onload="window.print()">
            <div class="invoice-box">
                <h1>CORTEZ SYNDICATE</h1>
                <h3>OFFICIAL TRANSACTION RECEIPT</h3>
                <hr>
                <div class="details">
                    <p><b>رقم الفاتورة (ID):</b> ${escapeHtml(order._id)}</p>
                    <p><b>اسم العضو:</b> ${escapeHtml(order.username)}</p>
                    <p><b>تاريخ الفاتورة:</b> ${new Date(order.timestamp).toLocaleString('en-GB')}</p>
                    <p><b>حالة الدفع:</b> ${order.status === 'Paid' ? '<span style="color:#00ff66;">تم استلام المبلغ بالكامل</span>' : '<span style="color:red;">غير مدفوعة</span>'}</p>
                </div>
                <hr>
                <ul>${itemsList}</ul>
                <div class="total">إجمالي الفاتورة: ${total}$</div>
                ${order.status === 'Paid' ? '<div class="stamp">AUTHORIZED & PAID</div>' : ''}
            </div>
        </body>
        </html>`;
        res.send(html);
    } catch (err) { res.status(500).send("خطأ في استرجاع الفاتورة: " + err.message); }
});

app.get('/api/admin/users', verifyAuth(['Underboss', 'GRH']), async (req, res) => {
    try {
        const users = await User.find({}, 'username role duty_status weekly_hours warnings is_blacklisted fine_amount fine_reason consecutive_misses');
        res.json(users);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/change-role', verifyAuth(['Underboss', 'GRH']), async (req, res) => {
    try {
        const { target_username, new_role } = req.body;
        if (new_role === 'Don') return res.status(403).json({ error: "لا يمكن منح رتبة الدون (Don) بهذه الطريقة!" });
        const oldUser = await User.findOne({ username: target_username }, 'role');
        await User.findOneAndUpdate({ username: target_username }, { role: new_role });
        await new AuditLog({
            action: 'role_changed', target_username, performed_by: req.user.username,
            details: `من ${oldUser ? oldUser.role : '?'} إلى ${new_role}`
        }).save();
        forceUserLogout(target_username);
        io.emit('dutyUpdated', {}); io.emit('auditLogUpdated');
        res.json({ msg: "تم تغيير الرتبة بنجاح." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/reset-password', verifyAuth(['Underboss', 'GRH']), async (req, res) => {
    try {
        const { target_username, new_password } = req.body;
        if (!new_password || new_password.length < 4) return res.status(400).json({ error: "كلمة المرور الجديدة قصيرة جداً (4 أحرف على الأقل)." });
        const hashedPassword = await bcrypt.hash(new_password, 10);
        const result = await User.findOneAndUpdate({ username: target_username }, { password: hashedPassword });
        if (!result) return res.status(404).json({ error: "العضو غير موجود." });
        await new AuditLog({ action: 'password_reset', target_username, performed_by: req.user.username, details: '' }).save();
        io.emit('auditLogUpdated');
        res.json({ msg: `تمت إعادة تعيين كلمة مرور "${target_username}" بنجاح. يرجى تسليمها له بشكل آمن.` });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/adjust-hours', verifyAuth(['Underboss', 'GRH']), async (req, res) => {
    try {
        const { target_username, new_hours } = req.body;
        if (new_hours === undefined || new_hours === '' || isNaN(new_hours) || Number(new_hours) < 0) {
            return res.status(400).json({ error: "الرقم المدخل غير صالح (0 أو أكثر)." });
        }
        const newMinutes = Math.round(Number(new_hours) * 60);
        const result = await User.findOneAndUpdate(
            { username: target_username },
            { weekly_hours: newMinutes, duty_status: 'OFF-DUTY' }
        );
        if (!result) return res.status(404).json({ error: "العضو غير موجود." });

        await new AuditLog({
            action: 'hours_adjusted', target_username, performed_by: req.user.username,
            details: `تصحيح الساعات إلى ${new_hours} ساعة (مع إرجاع الحالة OFF-DUTY)`
        }).save();
        io.emit('dutyUpdated', {});
        io.emit('auditLogUpdated');
        res.json({ msg: `تم تصحيح ساعات "${target_username}" إلى ${new_hours} ساعة مع إرجاعه OFF-DUTY.` });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/audit-log', verifyAuth(['Underboss', 'GRH']), async (req, res) => {
    try {
        const logs = await AuditLog.find().sort({ timestamp: -1 }).limit(200);
        res.json(logs);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/reset-weekly-hours', verifyAuth(['Don']), async (req, res) => {
    try {
        const currentUsers = await User.find({ is_blacklisted: false }, 'username role weekly_hours');
        await new Archive({ records: currentUsers }).save();
        
        await User.updateMany({}, { weekly_hours: 0, duty_status: 'OFF-DUTY', total_heists: 0 }); 
        await WeeklyPurchase.deleteMany({});
        
        io.emit('dutyUpdated');
        res.json({ msg: "تمت أرشفة الأسبوع وتصفير الساعات لكل الأعضاء بنجاح." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/archive', verifyAuth(['Underboss', 'GRH']), async (req, res) => {
    try { const archives = await Archive.find().sort({ week_date: -1 }); res.json(archives); } 
    catch (err) { res.status(500).json({ error: err.message }); }
});

// ================== v7.7: نظام الغرامات والعقوبات الإدارية ==================
app.post('/api/admin/penalty', verifyAuth(['Underboss', 'GRH']), async (req, res) => {
    try {
        const { target_username, type, reason, fine_amount } = req.body;
        const user = await User.findOne({ username: target_username });
        if (!user) return res.status(404).json({ error: "العضو غير موجود." });

        let penaltyAmount = 0;

        if (type === 'Warning') {
            user.warning_dates.push(new Date());
            user.warnings = user.warning_dates.length;
            if (user.warnings >= 3) { user.is_blacklisted = true; forceUserLogout(target_username); }
        } else if (type === 'Blacklist') {
            user.is_blacklisted = true; user.duty_status = 'OFF-DUTY';
            forceUserLogout(target_username);
        } else if (type === 'Remove_Blacklist') {
            user.is_blacklisted = false; user.warnings = 0; user.warning_dates = [];
        } else if (type === 'Fine') {
            penaltyAmount = Number(fine_amount || 0);
            if (penaltyAmount <= 0) return res.status(400).json({ error: "مبلغ الغرامة يجب أن يكون رقماً موجباً." });
            user.fine_amount += penaltyAmount;
            user.fine_reason = reason || "غرامة مفروضة من الإدارة";
        }
        
        await user.save();
        await new PenaltyLog({ target_username, admin_username: req.user.username, type, reason, fine_amount: penaltyAmount }).save();
        
        io.emit('dutyUpdated', { username: user.username, duty_status: user.duty_status });
        io.emit('finesUpdated');
        io.emit('notesUpdated');
        
        res.json({ msg: "تم تنفيذ الإجراء بنجاح." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// قائمة الأعضاء الذين عليهم غرامات معلقة (للوحة الإدارة)
app.get('/api/admin/fines/active', verifyAuth(['Underboss', 'GRH']), async (req, res) => {
    try {
        const finedUsers = await User.find({ fine_amount: { $gt: 0 } }, 'username role fine_amount fine_reason');
        res.json(finedUsers);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/fines/pay', verifyAuth(['Underboss', 'GRH']), async (req, res) => {
    try {
        const { target_username } = req.body;
        const user = await User.findOne({ username: target_username });
        if (!user || user.fine_amount <= 0) return res.status(400).json({ error: "العضو ليس عليه غرامة معلقة." });

        const amountPaid = user.fine_amount;
        
        user.fine_amount = 0;
        user.fine_reason = "";
        await user.save();

        await Treasury.updateOne({}, { $inc: { total_balance: amountPaid } });

        io.emit('finesUpdated');
        io.emit('treasuryUpdated');
        io.emit('dutyUpdated');
        
        res.json({ msg: `تم استلام الغرامة بقيمة ${amountPaid}$ وإضافتها إلى الخزينة العليا.` });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/stats/leaderboard', async (req, res) => {
    try {
        const users = await User.find({ is_blacklisted: false, account_status: 'approved', role: { $ne: 'Gang_Member' } }, 'username weekly_hours role duty_status');
        const fmt = users.map(u => ({ username: u.username, role: u.role, duty_status: u.duty_status, hours: u.weekly_hours }));
        
        res.json({ 
            leaderboard: [...fmt].sort((a,b)=> b.hours - a.hours), 
            slacking: fmt.filter(u=> u.hours < 600)
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/hr/leave', verifyAuth(['Underboss', 'Soldat', 'Capo', 'GRH', 'Chef_Braquage', 'Business_Manager', 'Gang_Supervisor']), async (req, res) => {
    try {
        await new Leave({ username: req.user.username, reason: req.body.reason, duration: Number(req.body.duration) }).save();
        io.emit('requestUpdated'); res.json({ msg: "تم إرسال طلب الإجازة بنجاح." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/hr/justify', verifyAuth(['Underboss', 'Soldat', 'Capo', 'GRH', 'Chef_Braquage', 'Business_Manager', 'Gang_Supervisor']), async (req, res) => {
    try {
        await new Justification({ username: req.user.username, reason: req.body.reason }).save();
        io.emit('requestUpdated'); res.json({ msg: "تم إرسال التبرير بنجاح." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// سجل طلبات الإجازة وتبرير الغياب بعد البت فيها — ظاهر لجميع الأعضاء في روم ABSENCE-CONGE
app.get('/api/hr/log', verifyAuth(['Underboss', 'Soldat', 'Capo', 'GRH', 'Chef_Braquage', 'Business_Manager', 'Gang_Supervisor']), async (req, res) => {
    try {
        const leaves = await Leave.find().sort({ timestamp: -1 });
        const justifications = await Justification.find().sort({ timestamp: -1 });
        res.json({ leaves, justifications });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/hr/requests', verifyAuth(['Underboss', 'GRH']), async (req, res) => {
    try {
        const leaves = await Leave.find({ status: 'Pending' });
        const justifications = await Justification.find({ status: 'Pending' });
        res.json({ leaves, justifications });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/hr/action', verifyAuth(['Underboss', 'GRH']), async (req, res) => {
    try {
        const { type, id, action } = req.body;
        if (type === 'leave') {
            await Leave.findByIdAndUpdate(id, { status: action });
            // عند اعتماد الإجازة تُسجل ملاحظة إدارية للعضو
            if (action === 'Approved') {
                const leave = await Leave.findById(id);
                if (leave) {
                    await new MemberNote({
                        username: leave.username,
                        reason: `إجازة معتمدة من الإدارة: ${leave.reason} لمدة ${leave.duration} أيام`,
                        issued_by: req.user.username,
                        bill_amount: 0
                    }).save();
                    io.emit('notesUpdated');
                }
            }
        }
        if (type === 'justify') await Justification.findByIdAndUpdate(id, { status: action });
        io.emit('requestUpdated'); res.json({ msg: "تم تحديث حالة الطلب بنجاح." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ================== v8.0: نظام الملاحظات ==================
app.post('/api/notes/add', verifyAuth(['Don', 'Underboss', 'GRH']), async (req, res) => {
    try {
        const { username, reason, bill_amount } = req.body;
        if (!username || !reason) return res.status(400).json({ error: "اسم المستخدم والسبب مطلوبان." });

        const note = new MemberNote({
            username,
            reason,
            issued_by: req.user.username,
            bill_amount: Number(bill_amount || 0)
        });
        await note.save();
        io.emit('notesUpdated');
        io.emit('dutyUpdated');
        res.status(201).json({ msg: "تمت إضافة الملاحظة بنجاح." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/notes/my', verifyAuth(['Underboss', 'Soldat', 'Capo', 'GRH', 'Chef_Braquage', 'Business_Manager', 'Gang_Supervisor']), async (req, res) => {
    try {
        const notes = await MemberNote.find({ username: req.user.username }).sort({ timestamp: -1 });
        res.json(notes);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/notes/all', verifyAuth(['Don', 'Underboss', 'GRH']), async (req, res) => {
    try {
        const notes = await MemberNote.find().sort({ timestamp: -1 });
        res.json(notes);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/notes/penalize', verifyAuth(['Don', 'Underboss', 'GRH']), async (req, res) => {
    try {
        const { username, reason, bill_amount } = req.body;
        if (!username || !reason) return res.status(400).json({ error: "اسم المستخدم والسبب مطلوبان." });

        const note = new MemberNote({
            username,
            reason,
            issued_by: req.user.username,
            bill_amount: Number(bill_amount || 0)
        });
        await note.save();

        // قاعدة: عند بلوغ 3 ملاحظات يتم تحويلها إلى إنذار رسمي
        const totalNotes = await MemberNote.countDocuments({ username });
        let warningsIssued = false;
        let blacklisted = false;

        if (totalNotes >= 3) {
            const user = await User.findOne({ username });
            if (user && !user.is_blacklisted) {
                user.warning_dates.push(new Date());
                user.warnings = user.warning_dates.length;
                if (user.warnings >= 3) {
                    user.is_blacklisted = true;
                    blacklisted = true;
                }
                await user.save();
                warningsIssued = true;

                await new PenaltyLog({
                    target_username: username,
                    admin_username: req.user.username,
                    type: 'Warning',
                    reason: `ملاحظات متراكمة: بلوغ ${totalNotes} ملاحظات`,
                    fine_amount: 0
                }).save();
            }
        }

        io.emit('notesUpdated');
        io.emit('dutyUpdated');
        io.emit('finesUpdated');

        let msg = "تمت إضافة الملاحظة بنجاح.";
        if (warningsIssued) msg += ` (${username} بلغ 3 ملاحظات وتحولت إلى إنذار رسمي.`;
        if (blacklisted) msg += ` تم وضعه في القائمة السوداء لبلوغ 3 إنذارات.)`;
        else if (warningsIssued) msg += ")";

        res.status(201).json({ msg, total_notes: totalNotes });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ================== v8.0: حذف ملاحظة ==================
app.delete('/api/notes/:id', verifyAuth(['Don', 'Underboss', 'GRH']), async (req, res) => {
    try {
        const note = await MemberNote.findByIdAndDelete(req.params.id);
        if (!note) return res.status(404).json({ error: "الملاحظة غير موجودة." });
        io.emit('notesUpdated');
        res.json({ msg: "تم حذف الملاحظة بنجاح." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ================== v8.0: سجل الحضور الأسبوعي (مبني على بصمات الدخول/الخروج الفعلية) ==================
// يوم الدوام الواحد يمتد من 22:00 إلى 04:00 بتوقيت الجزائر (ليلة الدوام تُحسب لليوم الذي تبدأ فيه)
app.get('/api/attendance/week', verifyAuth(['Don', 'Underboss', 'GRH', 'Business_Manager']), async (req, res) => {
    try {
        // تحديد آخر 7 أيام دوام (كل يوم دوام يمتد من 22:00 حتى 04:00 بتوقيت الجزائر)
        const days = [];
        for (let i = 6; i >= 0; i--) {
            const { start: startAbs, end: endAbs } = getDutyDayWindow(-i);
            const label = startAbs.toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
            days.push({ start: startAbs, end: endAbs, label });
        }

        const members = await User.find({
            is_blacklisted: false,
            account_status: 'approved',
            role: { $ne: 'Gang_Member' }
        }, 'username role last_punch_in');

        // جلب جميع بصمات الدخول المسجلة خلال الأسبوع
        const records = await PunchRecord.find({
            action: 'IN',
            timestamp: { $gte: days[0].start }
        });

        const byUser = {};
        records.forEach(r => {
            if (!byUser[r.username]) byUser[r.username] = [];
            byUser[r.username].push(new Date(r.timestamp).getTime());
        });

        const result = members.map(u => {
            const punches = byUser[u.username] || [];
            const dayStatus = days.map(d => {
                const inWindow = punches.some(t => t >= d.start.getTime() && t < d.end.getTime());
                // احتياط للبيانات القديمة قبل تفعيل سجل البصمات
                const legacyInWindow = u.last_punch_in && new Date(u.last_punch_in) >= d.start && new Date(u.last_punch_in) < d.end;
                return { date: d.label, present: inWindow || !!legacyInWindow };
            });
            const totalPresent = dayStatus.filter(d => d.present).length;
            return {
                username: u.username,
                role: u.role,
                days: dayStatus,
                total: totalPresent
            };
        });

        res.json({ days: days.map(d => d.label), attendance: result });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ================== v8.0: نظام المخزون / حاسبة البزنس مانجر ==================
app.post('/api/inventory/add', verifyAuth(['Don', 'Underboss', 'Business_Manager']), async (req, res) => {
    try {
        const { name, image_url, buy_from_gang_price, sell_to_black_price, quantity } = req.body;
        if (!name) return res.status(400).json({ error: "اسم المنتج مطلوب." });

        const item = new InventoryItem({
            name,
            image_url: image_url || undefined,
            buy_from_gang_price: Number(buy_from_gang_price || 0),
            sell_to_black_price: Number(sell_to_black_price || 0),
            quantity: Number(quantity || 0),
            created_by: req.user.username
        });
        await item.save();
        io.emit('inventoryUpdated');
        res.status(201).json({ msg: "تمت إضافة المنتج للمخزون بنجاح." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/inventory/items', verifyAuth(['Underboss', 'Soldat', 'Capo', 'GRH', 'Chef_Braquage', 'Business_Manager', 'Gang_Supervisor']), async (req, res) => {
    try {
        const items = await InventoryItem.find().sort({ timestamp: -1 });
        res.json(items);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/inventory/item/:id', verifyAuth(['Don', 'Underboss', 'Business_Manager']), async (req, res) => {
    try {
        const { name, image_url, buy_from_gang_price, sell_to_black_price, quantity } = req.body;
        const update = {};
        if (name !== undefined) update.name = name;
        if (image_url !== undefined) update.image_url = image_url;
        if (buy_from_gang_price !== undefined) update.buy_from_gang_price = Number(buy_from_gang_price);
        if (sell_to_black_price !== undefined) update.sell_to_black_price = Number(sell_to_black_price);
        if (quantity !== undefined) update.quantity = Number(quantity);

        await InventoryItem.findByIdAndUpdate(req.params.id, update);
        io.emit('inventoryUpdated');
        res.json({ msg: "تم تحديث المنتج بنجاح." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/inventory/item/:id', verifyAuth(['Don', 'Underboss', 'Business_Manager']), async (req, res) => {
    try {
        await InventoryItem.findByIdAndDelete(req.params.id);
        io.emit('inventoryUpdated');
        res.json({ msg: "تم حذف المنتج من المخزون بنجاح." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ================== الموافقة على الحسابات الجديدة (مافيا أو عصابات) — GRH أو الدون ==================
app.get('/api/admin/pending-accounts', verifyAuth(['Underboss', 'GRH']), async (req, res) => {
    try {
        const pending = await User.find({ account_status: 'pending' }, 'username role gang_name discord_id timestamp');
        res.json(pending);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/pending-accounts/review', verifyAuth(['Underboss', 'GRH']), async (req, res) => {
    try {
        const { target_username, decision } = req.body;
        if (!['approve', 'reject'].includes(decision)) return res.status(400).json({ error: "قرار غير صالح." });

        const user = await User.findOne({ username: target_username, account_status: 'pending' });
        if (!user) return res.status(404).json({ error: "المستخدم غير موجود أو ليس بانتظار الموافقة." });

        user.account_status = decision === 'approve' ? 'approved' : 'rejected';
        await user.save();
        await new AuditLog({
            action: decision === 'approve' ? 'account_approved' : 'account_rejected',
            target_username, performed_by: req.user.username,
            details: user.role === 'Gang_Member' ? `عضو عصابة: ${user.gang_name}` : 'عضو مافيا'
        }).save();
        io.emit('accountPending'); io.emit('auditLogUpdated');
        res.json({ msg: decision === 'approve' ? `تم قبول حساب ${target_username} بنجاح.` : `تم رفض حساب ${target_username}.` });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ================== شوب العصابات (التبادل التجاري بين العصابات والمافيا) ==================
app.get('/api/gang-shop/items', async (req, res) => {
    try { const items = await GangShopItem.find().sort({ timestamp: -1 }); res.json(items); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/gang-shop/add-item', verifyAuth(['Underboss', 'Business_Manager']), async (req, res) => {
    try {
        const { name, item_type, buy_price, sell_price, image_url, in_stock, max_per_order, max_per_week } = req.body;
        const validTypes = ['buy_only', 'sell_only', 'both'];
        const finalType = validTypes.includes(item_type) ? item_type : 'both';

        if (!name) return res.status(400).json({ error: "اسم المنتج مطلوب." });
        if ((finalType === 'buy_only' || finalType === 'both') && (buy_price === undefined || buy_price === null || buy_price === '')) return res.status(400).json({ error: "سعر الشراء مطلوب لهذا النوع من المنتجات." });
        if ((finalType === 'sell_only' || finalType === 'both') && (sell_price === undefined || sell_price === null || sell_price === '')) return res.status(400).json({ error: "سعر البيع مطلوب لهذا النوع من المنتجات." });

        const newItem = new GangShopItem({
            name, item_type: finalType,
            buy_price: (finalType === 'buy_only' || finalType === 'both') ? Number(buy_price) : null,
            sell_price: (finalType === 'sell_only' || finalType === 'both') ? Number(sell_price) : null,
            in_stock: in_stock !== undefined ? !!in_stock : true,
            max_per_order: (max_per_order === '' || max_per_order === undefined || max_per_order === null) ? null : Number(max_per_order),
            max_per_week: (max_per_week === '' || max_per_week === undefined || max_per_week === null) ? null : Number(max_per_week),
            image_url, created_by: req.user.username
        });
        await newItem.save();
        io.emit('gangShopUpdated');
        res.status(201).json({ msg: "تمت إضافة المنتج إلى شوب العصابات بنجاح." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/gang-shop/item/:id', verifyAuth(['Underboss', 'Business_Manager']), async (req, res) => {
    try {
        const { name, item_type, buy_price, sell_price, image_url, in_stock, max_per_order, max_per_week } = req.body;
        const item = await GangShopItem.findById(req.params.id);
        if (!item) return res.status(404).json({ error: "المنتج غير موجود." });

        if (name !== undefined) item.name = name;
        if (image_url !== undefined) item.image_url = image_url;
        if (in_stock !== undefined) item.in_stock = !!in_stock;
        if (max_per_order !== undefined) item.max_per_order = (max_per_order === '' || max_per_order === null) ? null : Number(max_per_order);
        if (max_per_week !== undefined) item.max_per_week = (max_per_week === '' || max_per_week === null) ? null : Number(max_per_week);

        const validTypes = ['buy_only', 'sell_only', 'both'];
        if (item_type !== undefined && validTypes.includes(item_type)) item.item_type = item_type;

        if (item.item_type === 'buy_only' || item.item_type === 'both') {
            if (buy_price !== undefined) item.buy_price = Number(buy_price);
            if (!item.buy_price) return res.status(400).json({ error: "سعر الشراء مطلوب لهذا النوع من المنتجات." });
        } else { item.buy_price = null; }

        if (item.item_type === 'sell_only' || item.item_type === 'both') {
            if (sell_price !== undefined) item.sell_price = Number(sell_price);
            if (!item.sell_price) return res.status(400).json({ error: "سعر البيع مطلوب لهذا النوع من المنتجات." });
        } else { item.sell_price = null; }

        await item.save();
        io.emit('gangShopUpdated');
        res.json({ msg: "تم تحديث المنتج بنجاح." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/gang-shop/item/:id', verifyAuth(['Underboss', 'Business_Manager']), async (req, res) => {
    try {
        await GangShopItem.findByIdAndDelete(req.params.id);
        io.emit('gangShopUpdated');
        res.json({ msg: "تم حذف المنتج بنجاح." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

const MAX_QTY_PER_LINE = 100000;

app.post('/api/gang-shop/checkout', verifyAuth(['Gang_Member']), async (req, res) => {
    try {
        const { items_bought, items_sold } = req.body;
        if ((!items_bought || items_bought.length === 0) && (!items_sold || items_sold.length === 0)) {
            return res.status(400).json({ error: "لا توجد عملية شراء أو بيع." });
        }

        const catalog = await GangShopItem.find();
        const findItem = (name) => catalog.find(c => c.name === name);
        const username = req.user.username;

        let total_buy_value = 0;
        const processedBought = [];
        for (const i of (items_bought || [])) {
            const catalogItem = findItem(i.name);
            if (!catalogItem) throw new Error(`المنتج "${i.name}" غير موجود في الكتالوج.`);
            if (catalogItem.item_type === 'sell_only') throw new Error(`المنتج "${i.name}" غير قابل للشراء (بيع فقط).`);
            if (!catalogItem.in_stock) throw new Error(`المنتج "${i.name}" غير متوفر حالياً (نفذت الكمية).`);

            const qty = Math.max(1, parseInt(i.quantity) || 1);
            if (qty > MAX_QTY_PER_LINE) throw new Error(`الكمية المطلوبة من "${i.name}" تتجاوز الحد المسموح في الطلب.`);
            if (catalogItem.max_per_order && qty > catalogItem.max_per_order) {
                throw new Error(`الكمية المطلوبة من المنتج "${i.name}" تتجاوز الحد المسموح للطلب (${catalogItem.max_per_order} قطع).`);
            }
            if (catalogItem.max_per_week) {
                const record = await WeeklyPurchase.findOne({ username, item_name: i.name, shop_type: 'gang_shop' });
                const alreadyBought = record ? record.quantity_bought : 0;
                if (alreadyBought + qty > catalogItem.max_per_week) {
                    const remaining = Math.max(0, catalogItem.max_per_week - alreadyBought);
                    throw new Error(`لقد وصلت للحد الأسبوعي للمنتج "${i.name}" (${catalogItem.max_per_week} قطع). المتبقي: ${remaining}.`);
                }
            }

            const total = catalogItem.buy_price * qty;
            total_buy_value += total;
            processedBought.push({ name: i.name, quantity: qty, unit_price: catalogItem.buy_price, total, max_per_week: catalogItem.max_per_week });
        }

        let total_sell_value = 0;
        const processedSold = (items_sold || []).map(i => {
            const catalogItem = findItem(i.name);
            if (!catalogItem) throw new Error(`المنتج "${i.name}" غير موجود في الكتالوج.`);
            if (catalogItem.item_type === 'buy_only') throw new Error(`المنتج "${i.name}" غير قابل للبيع (شراء فقط).`);
            const qty = Math.max(1, parseInt(i.quantity) || 1);
            if (qty > MAX_QTY_PER_LINE) throw new Error(`الكمية المطلوبة من "${i.name}" تتجاوز الحد المسموح في الطلب.`);
            const total = catalogItem.sell_price * qty;
            total_sell_value += total;
            return { name: i.name, quantity: qty, unit_price: catalogItem.sell_price, total };
        });

        const net_amount = total_buy_value - total_sell_value;
        const user = await User.findOne({ username: req.user.username });

        for (const p of processedBought) {
            if (p.max_per_week) {
                await WeeklyPurchase.updateOne(
                    { username, item_name: p.name, shop_type: 'gang_shop' },
                    { $inc: { quantity_bought: p.quantity } },
                    { upsert: true }
                );
            }
        }
        const finalBought = processedBought.map(p => ({ name: p.name, quantity: p.quantity, unit_price: p.unit_price, total: p.total }));

        const newOrder = new GangOrder({
            gang_member_username: req.user.username,
            gang_name: user ? user.gang_name : '',
            items_bought: finalBought, items_sold: processedSold,
            total_buy_value, total_sell_value, net_amount, status: 'Pending'
        });
        await newOrder.save();
        io.emit('gangOrdersUpdated');
        res.status(201).json({ msg: "تم إرسال طلب المقايضة بنجاح. بانتظار تأكيد الإدارة." });
    } catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/api/gang-shop/my-orders', verifyAuth(['Gang_Member']), async (req, res) => {
    try {
        const orders = await GangOrder.find({ gang_member_username: req.user.username }).sort({ timestamp: -1 });
        res.json(orders);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// إلغاء/تعديل طلب معلّق من العضو صاحب الطلب نفسه فقط
app.post('/api/gang-shop/order/:id/cancel', verifyAuth(['Gang_Member']), async (req, res) => {
    try {
        const order = await GangOrder.findById(req.params.id);
        if (!order || order.gang_member_username !== req.user.username || order.status !== 'Pending') {
            return res.status(400).json({ error: "الطلب غير موجود أو لم يعد معلقاً (لا يمكن إلغاؤه)." });
        }
        order.status = 'Cancelled';
        await order.save();
        io.emit('gangOrdersUpdated');
        res.json({ msg: "تم إلغاء الطلب." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/gang-shop/orders', verifyAuth(['Don', 'Underboss', 'Business_Manager', 'GRH', 'Chef_Braquage']), async (req, res) => {
    try { const orders = await GangOrder.find().sort({ timestamp: -1 }); res.json(orders); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/gang-shop/order/:id/confirm', verifyAuth(['Don', 'Underboss', 'Business_Manager', 'GRH', 'Chef_Braquage']), async (req, res) => {
    try {
        const order = await GangOrder.findById(req.params.id);
        if (!order || order.status !== 'Pending') return res.status(400).json({ error: "الطلب غير موجود أو لم يعد معلقاً." });

        order.status = 'Confirmed';
        await order.save();
        await GangTreasury.updateOne({}, { $inc: { total_balance: order.net_amount } });

        io.emit('gangOrdersUpdated'); io.emit('gangTreasuryUpdated');
        res.json({ msg: "تم تأكيد الطلب وإضافة المبلغ إلى الخزينة." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/gang-shop/order/:id/reject', verifyAuth(['Don', 'Underboss', 'Business_Manager', 'GRH', 'Chef_Braquage']), async (req, res) => {
    try {
        const { reason } = req.body;
        const order = await GangOrder.findById(req.params.id);
        if (!order || order.status !== 'Pending') return res.status(400).json({ error: "الطلب غير موجود أو لم يعد معلقاً." });

        order.status = 'Rejected';
        order.rejection_reason = reason || '';
        await order.save();
        io.emit('gangOrdersUpdated');
        res.json({ msg: "تم رفض الطلب." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/gang-shop/treasury', verifyAuth(['Don', 'Underboss', 'Business_Manager', 'GRH', 'Chef_Braquage']), async (req, res) => {
    try {
        const treasury = await GangTreasury.findOne({});
        const balance = treasury ? treasury.total_balance : 0;
        res.json({ balance_raw: balance, balance_formatted: formatMoneyShort(balance) });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/gang-shop/treasury/reset', verifyAuth(['Don']), async (req, res) => {
    try {
        await GangTreasury.updateOne({}, { total_balance: 0 });
        io.emit('gangTreasuryUpdated');
        res.json({ msg: "تم تصفير خزينة شوب العصابات بنجاح." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ================== إزالة الإنذارات (المسارات الإدارية) ==================
app.post('/api/admin/remove-warning', verifyAuth(['Don', 'Underboss', 'GRH']), async (req, res) => {
    try {
        const { target_username } = req.body;
        const user = await User.findOne({ username: target_username });
        if (!user) return res.status(404).json({ error: "العضو غير موجود." });
        if (user.warnings <= 0) return res.status(400).json({ error: "العضو ليس عليه إنذارات." });

        const dates = user.warning_dates || [];
        if (dates.length > 0) dates.shift();
        user.warning_dates = dates;
        user.warnings = dates.length;
        await user.save();

        await new AuditLog({
            action: 'warning_removed',
            target_username,
            performed_by: req.user.username,
            details: `إزالة إنذار واحد (المتبقي: ${user.warnings})`
        }).save();

        io.emit('dutyUpdated', {});
        io.emit('auditLogUpdated');
        res.json({ msg: `تمت إزالة إنذار واحد من "${target_username}". الإنذارات المتبقية: ${user.warnings}` });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ================== إزالة القائمة السوداء وتصفير الإنذارات ==================
app.post('/api/admin/blacklist/remove', verifyAuth(['Don']), async (req, res) => {
    try {
        const { target_username } = req.body;
        const user = await User.findOne({ username: target_username });
        if (!user) return res.status(404).json({ error: "العضو غير موجود." });
        user.is_blacklisted = false;
        user.warnings = 0;
        user.warning_dates = [];
        await user.save();
        await new AuditLog({
            action: 'blacklist_removed',
            target_username,
            performed_by: req.user.username,
            details: 'الإخراج من القائمة السوداء وتصفير الإنذارات'
        }).save();
        io.emit('dutyUpdated', {});
        io.emit('auditLogUpdated');
        res.json({ msg: `تم إخراج "${target_username}" من القائمة السوداء بنجاح.` });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ================== قائمة الأعضاء الذين لديهم إنذارات ==================
app.get('/api/admin/warnings/list', verifyAuth(['Don', 'Underboss', 'GRH', 'Business_Manager']), async (req, res) => {
    try {
        const warnedUsers = await User.find(
            { warnings: { $gt: 0 }, is_blacklisted: false },
            'username role warnings warning_dates consecutive_misses'
        ).sort({ warnings: -1 });
        res.json(warnedUsers.map(u => ({
            username: u.username,
            role: u.role,
            warnings: u.warnings,
            last_warning_date: u.warning_dates.length > 0 ? u.warning_dates[u.warning_dates.length - 1] : null,
            consecutive_misses: u.consecutive_misses
        })));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ================== v8.1: نظام بطولة Champion Cup ==================
const TOURNAMENT_MANAGERS = ['Underboss']; // Don يُمرَّر تلقائياً عبر verifyAuth
const TOURNAMENT_VIEWERS = ['Underboss', 'GRH', 'Business_Manager', 'Chef_Braquage', 'Capo', 'Soldat', 'Gang_Supervisor', 'Gang_Member']; // Don تلقائياً

// قائمة العصابات (من موديل Gang) — للعرض وللإدارة
app.get('/api/tournaments/gangs', verifyAuth(TOURNAMENT_VIEWERS), async (req, res) => {
    try {
        const gangs = await Gang.find({}).select('name').sort({ name: 1 });
        res.json(gangs);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// إطلاق بطولة جديدة (يجلب العصابات الحالية أوتوماتيكياً)
app.post('/api/tournaments', verifyAuth(TOURNAMENT_MANAGERS), async (req, res) => {
    try {
        const active = await Tournament.findOne({ status: { $in: ['setup', 'ongoing'] } });
        if (active) return res.status(400).json({ error: "يوجد بطولة نشطة حالياً. أكملها أو ألغِها قبل إطلاق جديدة." });
        const allGangs = await Gang.find({}).select('name');
        const tournament = await new Tournament({ createdBy: req.user.username }).save();
        await new AuditLog({ action: 'tournament_created', target_username: '-', performed_by: req.user.username, details: `تم إطلاق ${tournament.name} (${allGangs.length} عصابة)` }).save();
        io.emit('auditLogUpdated');
        io.emit('tournament:created', { tournamentId: tournament._id });
        res.json({ tournament, availableGangs: allGangs });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

async function loadTournamentById(id) {
    return Tournament.findById(id)
        .populate('gangs', 'name')
        .populate('groups.gangs', 'name')
        .populate('champion', 'name');
}

// البطولة الحالية (تفاصيل كاملة)
app.get('/api/tournaments/current', verifyAuth(TOURNAMENT_VIEWERS), async (req, res) => {
    try {
        const t = await Tournament.findOne({ status: { $in: ['setup', 'ongoing'] } });
        if (!t) return res.json(null);
        const full = await loadTournamentById(t._id);
        const matches = await Match.find({ tournamentId: t._id });
        res.json({ ...full.toObject(), matches });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// مباريات اليوم — أو أقرب مباراة قادمة
app.get('/api/tournaments/today-matches', verifyAuth(TOURNAMENT_VIEWERS), async (req, res) => {
    try {
        const active = await Tournament.findOne({ status: { $in: ['setup', 'ongoing'] } });
        if (!active) return res.json([]);
        const matches = await Match.find({ tournamentId: active._id, status: 'scheduled', scheduledAt: { $ne: null } })
            .sort({ scheduledAt: 1 }).select('stage groupNumber gangA gangB scheduledAt weapons');
        const now = new Date();
        const startOfToday = new Date(now); startOfToday.setHours(0, 0, 0, 0);
        const endOfToday = new Date(now); endOfToday.setHours(23, 59, 59, 999);
        const today = matches.filter(m => m.scheduledAt >= startOfToday && m.scheduledAt <= endOfToday);
        res.json(today.length ? today : matches.slice(0, 3));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// أرشيف البطولات السابقة
app.get('/api/tournaments/archive', verifyAuth(TOURNAMENT_VIEWERS), async (req, res) => {
    try {
        const list = await Tournament.find({ status: { $in: ['completed', 'cancelled'] } })
            .populate('champion', 'name').sort({ createdAt: -1 });
        res.json(list);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// تفاصيل بطولة معينة (من الأرشيف)
app.get('/api/tournaments/:id', verifyAuth(TOURNAMENT_VIEWERS), async (req, res) => {
    try {
        const t = await loadTournamentById(req.params.id);
        if (!t) return res.status(404).json({ error: "البطولة غير موجودة." });
        const matches = await Match.find({ tournamentId: t._id });
        res.json({ ...t.toObject(), matches });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// توزيع العصابات على 4 مجموعات (عصابتين لكل مجموعة)
app.put('/api/tournaments/:id/groups', verifyAuth(TOURNAMENT_MANAGERS), async (req, res) => {
    try {
        const t = await Tournament.findById(req.params.id);
        if (!t || t.status === 'completed' || t.status === 'cancelled') return res.status(400).json({ error: "البطولة غير صالحة للتعديل." });
        const groups = req.body.groups; // [{ gangA: id, gangB: id }] — 4 مجموعات
        if (!Array.isArray(groups) || groups.length !== 4) return res.status(400).json({ error: "لازم 4 مجموعات بالضبط." });
        const used = new Set();
        const gangIds = [];
        for (const g of groups) {
            const a = String(g.gangA), b = String(g.gangB);
            if (!a || !b || a === b) return res.status(400).json({ error: "كل مجموعة لازم يكون فيها عصابة مختلفة." });
            if (used.has(a) || used.has(b)) return res.status(400).json({ error: "لا يمكن تكرار عصابة في أكثر من مجموعة." });
            used.add(a); used.add(b);
            gangIds.push(a, b);
        }
        t.gangs = gangIds;
        t.groups = [];
        t.semiFinals = []; t.final = null; t.champion = null; t.distributedAt = null;
        await Match.deleteMany({ tournamentId: t._id });
        for (let i = 0; i < 4; i++) {
            const m = await new Match({ tournamentId: t._id, stage: 'group', groupNumber: i + 1, gangA: groups[i].gangA, gangB: groups[i].gangB }).save();
            t.groups.push({ groupNumber: i + 1, gangs: [groups[i].gangA, groups[i].gangB], matchId: m._id });
        }
        t.status = 'ongoing';
        await t.save();
        await new AuditLog({ action: 'tournament_groups', target_username: '-', performed_by: req.user.username, details: `تم توزيع مجموعات ${t.name}` }).save();
        io.emit('auditLogUpdated');
        io.emit('tournament:groups-assigned', { tournamentId: t._id });
        const full = await loadTournamentById(t._id);
        res.json(full);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// جدولة مباراة (تاريخ + وقت + 3 أسلحة)
app.post('/api/tournaments/:id/matches/:matchId/schedule', verifyAuth(TOURNAMENT_MANAGERS), async (req, res) => {
    try {
        const t = await Tournament.findById(req.params.id);
        if (!t || t.status !== 'ongoing') return res.status(400).json({ error: "البطولة غير نشطة." });
        const m = await Match.findOne({ _id: req.params.matchId, tournamentId: t._id });
        if (!m) return res.status(404).json({ error: "المباراة غير موجودة." });
        if (m.status === 'completed') return res.status(400).json({ error: "لا يمكن تعديل مباراة منتهية." });
        if (!req.body.scheduledAt) return res.status(400).json({ error: "أدخل تاريخ ووقت المباراة." });
        const weapons = Array.isArray(req.body.weapons) ? req.body.weapons.filter(x => x && String(x).trim()).map(x => String(x).trim()).slice(0, 3) : [];
        if (weapons.length === 0) return res.status(400).json({ error: "أدخل سلاح راوند واحد على الأقل." });
        m.scheduledAt = new Date(req.body.scheduledAt);
        m.weapons = weapons;
        await m.save();
        await new AuditLog({ action: 'tournament_match_scheduled', target_username: '-', performed_by: req.user.username, details: `جدولة مباراة (${m.stage}${m.groupNumber ? ' G' + m.groupNumber : ''}) في ${t.name}` }).save();
        io.emit('auditLogUpdated');
        io.emit('tournament:match-scheduled', { tournamentId: t._id, matchId: m._id });
        res.json(m);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// إعادة حساب شجرة التأهل بناءً على النتائج المسجلة
async function recomputeBracket(t) {
    const groups = await Match.find({ tournamentId: t._id, stage: 'group' });
    const byGroup = {};
    groups.forEach(x => { byGroup[x.groupNumber] = x; });
    const allGroupDone = groups.length === 4 && groups.every(x => x.status === 'completed');

    let semis = await Match.find({ tournamentId: t._id, stage: 'semifinal' });
    if (allGroupDone) {
        const pairs = [[byGroup[1].result.winner, byGroup[2].result.winner], [byGroup[3].result.winner, byGroup[4].result.winner]];
        if (semis.length < 2) {
            for (let i = semis.length; i < 2; i++) {
                semis.push(await new Match({ tournamentId: t._id, stage: 'semifinal', gangA: pairs[i][0], gangB: pairs[i][1] }).save());
            }
        } else {
            semis.forEach((s, i) => {
                if (s.status !== 'completed' && pairs[i]) { s.gangA = pairs[i][0]; s.gangB = pairs[i][1]; }
            });
            await Promise.all(semis.map(s => s.save()));
        }
        t.semiFinals = semis.map(s => s._id);
    }

    const allSemisDone = semis.length === 2 && semis.every(x => x.status === 'completed');
    let finalM = t.final ? await Match.findById(t.final) : null;
    if (allSemisDone) {
        if (!finalM) {
            finalM = await new Match({ tournamentId: t._id, stage: 'final', gangA: semis[0].result.winner, gangB: semis[1].result.winner }).save();
            t.final = finalM._id;
        } else if (finalM.status !== 'completed') {
            finalM.gangA = semis[0].result.winner; finalM.gangB = semis[1].result.winner;
            await finalM.save();
        }
    }
    if (finalM && finalM.status === 'completed') {
        t.champion = finalM.result.winner;
        t.status = 'completed';
        t.completedAt = new Date();
    }
    await t.save();
}

// تسجيل نتيجة مباراة (Best of 3) + التأهل الأوتوماتيكي
app.post('/api/tournaments/:id/matches/:matchId/result', verifyAuth(TOURNAMENT_MANAGERS), async (req, res) => {
    try {
        const t = await Tournament.findById(req.params.id);
        if (!t || t.status !== 'ongoing') return res.status(400).json({ error: "البطولة غير نشطة." });
        const m = await Match.findOne({ _id: req.params.matchId, tournamentId: t._id });
        if (!m) return res.status(404).json({ error: "المباراة غير موجودة." });
        if (!m.gangA || !m.gangB) return res.status(400).json({ error: "المباراة ما زالت بدون عصابات." });
        const scoreA = Number(req.body.scoreA), scoreB = Number(req.body.scoreB);
        const valid = (scoreA === 2 && (scoreB === 0 || scoreB === 1)) || (scoreB === 2 && (scoreA === 0 || scoreA === 1));
        if (!valid) return res.status(400).json({ error: "نتيجة غير صحيحة: في Best of 3 الفايز لازم يكون 2 والثاني 0 أو 1." });
        const winner = scoreA > scoreB ? m.gangA : m.gangB;
        m.result = { scoreA, scoreB, winner, notes: String(req.body.notes || ''), recordedBy: req.user.username, recordedAt: new Date() };
        m.status = 'completed';
        await m.save();
        await recomputeBracket(t);
        await new AuditLog({ action: 'tournament_result', target_username: '-', performed_by: req.user.username, details: `نتيجة ${scoreA}-${scoreB} في ${t.name}` }).save();
        io.emit('auditLogUpdated');
        io.emit('tournament:match-completed', { tournamentId: t._id, matchId: m._id, winner });
        if (t.status === 'completed') {
            io.emit('tournament:completed', { tournamentId: t._id, champion: t.champion });
        } else {
            io.emit('tournament:stage-advanced', { tournamentId: t._id });
        }
        const full = await loadTournamentById(t._id);
        res.json(full);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// تعديل نتيجة مسجلة (قبل إغلاق البطولة)
app.put('/api/tournaments/:id/matches/:matchId/result', verifyAuth(TOURNAMENT_MANAGERS), async (req, res) => {
    try {
        const t = await Tournament.findById(req.params.id);
        if (!t || t.status === 'completed' || t.status === 'cancelled') return res.status(400).json({ error: "لا يمكن تعديل النتيجة بعد إغلاق البطولة." });
        const m = await Match.findOne({ _id: req.params.matchId, tournamentId: t._id });
        if (!m || m.status !== 'completed') return res.status(400).json({ error: "المباراة غير موجودة أو غير مسجلة." });
        const scoreA = Number(req.body.scoreA), scoreB = Number(req.body.scoreB);
        const valid = (scoreA === 2 && (scoreB === 0 || scoreB === 1)) || (scoreB === 2 && (scoreA === 0 || scoreA === 1));
        if (!valid) return res.status(400).json({ error: "نتيجة غير صحيحة: الفايز لازم يكون 2 والثاني 0 أو 1." });
        m.result.scoreA = scoreA; m.result.scoreB = scoreB;
        m.result.winner = scoreA > scoreB ? m.gangA : m.gangB;
        m.result.notes = String(req.body.notes || '');
        await m.save();
        await recomputeBracket(t);
        await new AuditLog({ action: 'tournament_result_edited', target_username: '-', performed_by: req.user.username, details: `تعديل نتيجة في ${t.name}` }).save();
        io.emit('auditLogUpdated');
        io.emit('tournament:match-completed', { tournamentId: t._id, matchId: m._id });
        if (t.status === 'completed') io.emit('tournament:completed', { tournamentId: t._id, champion: t.champion });
        else io.emit('tournament:stage-advanced', { tournamentId: t._id });
        const full = await loadTournamentById(t._id);
        res.json(full);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// إدارة الجوايز (من عناصر الشوب)
app.put('/api/tournaments/:id/prizes', verifyAuth(TOURNAMENT_MANAGERS), async (req, res) => {
    try {
        const t = await Tournament.findById(req.params.id);
        if (!t || t.status === 'completed' || t.status === 'cancelled') return res.status(400).json({ error: "لا يمكن تعديل الجوايز بعد إغلاق البطولة." });
        const items = req.body.items;
        if (!Array.isArray(items)) return res.status(400).json({ error: "بيانات غير صحيحة." });
        const prizePool = [];
        for (const it of items) {
            const qty = Math.max(1, Number(it.quantity) || 1);
            const shopItem = await Item.findById(it.shopItemId);
            if (!shopItem) return res.status(400).json({ error: "منتج غير موجود في الشوب." });
            prizePool.push({ shopItemId: shopItem._id, name: shopItem.name, image: shopItem.image_url, price: shopItem.price, quantity: qty });
        }
        t.prizePool = prizePool;
        await t.save();
        io.emit('tournament:prizes-updated', { tournamentId: t._id });
        res.json(t);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// توزيع الجوايز على العصابة البطلة (Don فقط)
app.post('/api/tournaments/:id/distribute-prizes', verifyAuth([]), async (req, res) => {
    try {
        const t = await Tournament.findById(req.params.id);
        if (!t || t.status !== 'completed') return res.status(400).json({ error: "البطولة لم تكتمل بعد." });
        if (!t.champion) return res.status(400).json({ error: "لم يتم تحديد البطل." });
        if (t.distributedAt) return res.status(400).json({ error: "تم توزيع الجوايز مسبقاً." });
        t.distributedAt = new Date();
        await t.save();
        await new AuditLog({ action: 'tournament_prizes_distributed', target_username: '-', performed_by: req.user.username, details: `توزيع جوايز ${t.name} على ${t.champion}` }).save();
        io.emit('auditLogUpdated');
        io.emit('tournament:prizes-distributed', { tournamentId: t._id });
        res.json({ msg: "تم توزيع الجوايز على العصابة البطلة." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// إلغاء البطولة
app.post('/api/tournaments/:id/cancel', verifyAuth(TOURNAMENT_MANAGERS), async (req, res) => {
    try {
        const t = await Tournament.findById(req.params.id);
        if (!t || t.status === 'completed' || t.status === 'cancelled') return res.status(400).json({ error: "البطولة غير صالحة للإلغاء." });
        t.status = 'cancelled';
        t.completedAt = new Date();
        await t.save();
        await new AuditLog({ action: 'tournament_cancelled', target_username: '-', performed_by: req.user.username, details: `إلغاء ${t.name}` }).save();
        io.emit('auditLogUpdated');
        io.emit('tournament:cancelled', { tournamentId: t._id });
        res.json({ msg: "تم إلغاء البطولة وحفظها في الأرشيف." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ================== تقديم واجهة التطبيق ==================
// إذا وُجد index.html داخل public/ فيتم تقديمه تلقائياً عبر express.static أعلاه؛
// وإلا نقدّم الملف من جذر المشروع مباشرة (للعمل المحلي وبدون مجلد public)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ================== معالجة المسارات غير المعروفة (يجب أن يكون في النهاية دائماً) ==================
app.use('/api', (req, res) => {
    res.status(404).json({ error: "المسار غير موجود في النظام: " + req.originalUrl });
});

// ================== طرد المستخدم فوراً عند تغيير صلاحياته أو حظره ==================
const forceUserLogout = (username) => {
    const sockets = userSockets[username];
    if (sockets) {
        sockets.forEach(sid => {
            io.to(sid).emit('forceLogout', { reason: 'تم تغيير صلاحياتك أو حظرك من النظام. يرجى إعادة تسجيل الدخول.' });
        });
    }
};

// ---------------- Sockets ----------------
io.on('connection', (socket) => {
    // ربط السوكيت باسم المستخدم المسجل
    socket.on('register', async (data) => {
        if (data && data.username) {
            try {
                const user = await User.findOne({ username: data.username }).select('account_status is_blacklisted');
                if (!user || user.account_status !== 'approved' || user.is_blacklisted) {
                    socket.emit('forceLogout', { reason: 'حسابك غير موجود أو تم حظره من النظام.' });
                    return;
                }
            } catch(e){}
            socketUsers[socket.id] = data.username;
            if (!userSockets[data.username]) userSockets[data.username] = [];
            if (!userSockets[data.username].includes(socket.id)) {
                userSockets[data.username].push(socket.id);
            }
        }
    });

    socket.on('disconnect', () => {
        delete socketUsers[socket.id];
        for (const username in userSockets) {
            userSockets[username] = userSockets[username].filter(id => id !== socket.id);
            if (userSockets[username].length === 0) delete userSockets[username];
        }
    });

    socket.on('triggerEmergency', async (data) => {
        const username = socketUsers[socket.id];
        if (!username) return;
        // التحقق من الصلاحية: الدون أو النائب فقط
        const user = await User.findOne({ username }, 'role');
        if (!user || (user.role !== 'Don' && user.role !== 'Underboss')) return;
        io.emit('emergencyAlert', {
            message: "تم تفعيل استنفار عام! جميع الأعضاء يجب أن يتواجدوا فوراً في المدينة.",
            sender: username
        });
    });

    socket.on('toggleDuty', async (data) => {
        try {
            // تحقق أمني: لا يمكن لأي مستخدم تشغيل/إيقاف دوام مستخدم آخر
            if (!data || !data.username || socketUsers[socket.id] !== data.username) {
                socket.emit('statusResponse', { error: 'غير مصرح لك بتنفيذ هذه العملية.' });
                return;
            }
            const user = await User.findOne({ username: data.username, is_blacklisted: false });
            if (!user) return;
            const now = new Date();
            if (user.duty_status === 'OFF-DUTY') {
                // التحقق من نافذة الدوام المسموحة (22:00 - 04:00 بتوقيت الجزائر)
                if (!isInDutyTimeWindow()) {
                    socket.emit('statusResponse', { error: "لا يمكن تفعيل الدوام خارج الساعات المسموحة (22:00 - 04:00 بتوقيت الجزائر)." });
                    return;
                }
                user.duty_status = 'ON-DUTY'; user.last_punch_in = now;
                await new PunchRecord({ username: user.username, action: 'IN', timestamp: now }).save();
            } else {
                if (user.last_punch_in) user.weekly_hours += Math.floor((now - user.last_punch_in) / 60000);
                user.duty_status = 'OFF-DUTY';
                await new PunchRecord({ username: user.username, action: 'OUT', timestamp: now }).save();
            }
            await user.save();
            io.emit('dutyUpdated', { username: user.username, duty_status: user.duty_status });
            io.emit('attendanceUpdated');
            socket.emit('statusResponse', { username: user.username, duty_status: user.duty_status });
        } catch (err) { console.error(err.message); }
    });
});

// ================== فحص دوري كل 5 دقائق: إيقاف دوام كل من بقي ON-DUTY خارج النافذة أو تجاوز 8 ساعات ==================
setInterval(async () => {
    try {
        // إيقاف دوام أي مستخدم خارج نافذة 22:00-04:00
        if (!isInDutyTimeWindow()) {
            const activeUsers = await User.find({ duty_status: 'ON-DUTY' });
            for (let u of activeUsers) {
                if (u.last_punch_in) u.weekly_hours += Math.floor((new Date() - u.last_punch_in) / 60000);
                u.duty_status = 'OFF-DUTY';
                await u.save();
            }
            if (activeUsers.length > 0) { io.emit('dutyUpdated', {}); io.emit('attendanceUpdated'); }
        }

        // الحد الأقصى: إيقاف الدوام بعد تجاوز 8 ساعات متواصلة
        const allActiveUsers = await User.find({ duty_status: 'ON-DUTY' });
        const maxTimeMs = 8 * 60 * 60 * 1000; 
        const now = new Date();
        let stateChanged = false;

        for (let u of allActiveUsers) {
            if (u.last_punch_in && (now - u.last_punch_in > maxTimeMs)) {
                u.weekly_hours += Math.floor((now - u.last_punch_in) / 60000);
                u.duty_status = 'OFF-DUTY';
                await u.save();
                stateChanged = true;
            }
        }
        if (stateChanged) { io.emit('dutyUpdated', {}); io.emit('attendanceUpdated'); }
    } catch (err) { console.error(err.message); }
}, 300000); 

// ================== تنظيف الإنذارات المنتهية (بعد 30 يوماً) ==================
const WARNING_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;

async function cleanupExpiredWarnings() {
    try {
        const now = new Date();
        const usersWithWarnings = await User.find({ 'warning_dates.0': { $exists: true } });

        for (let u of usersWithWarnings) {
            const beforeCount = u.warning_dates.length;
            u.warning_dates = u.warning_dates.filter(d => (now - new Date(d)) < WARNING_EXPIRY_MS);

            if (u.warning_dates.length !== beforeCount) {
                u.warnings = u.warning_dates.length;
                await u.save();
            }
        }
        io.emit('dutyUpdated', {});
    } catch (err) { console.error("خطأ في تنظيف الإنذارات:", err.message); }
}

setInterval(cleanupExpiredWarnings, 3600000);
cleanupExpiredWarnings();

// ================== الملاحظات التلقائية للغياب — تُرسل يومياً في الساعة 04:00 بتوقيت الجزائر ==================
let lastAutoNoteDate = '';
setInterval(async () => {
    try {
        const now = new Date();
        const dzNow = new Date(now.getTime() + (60 * 60 * 1000));
        const hours = dzNow.getUTCHours();
        const minutes = dzNow.getUTCMinutes();
        if (hours !== 4 || minutes > 0) return;

        // ضمان إرسال الملاحظة مرة واحدة فقط في اليوم
        const todayStr = dzNow.toISOString().slice(0, 10);
        if (lastAutoNoteDate === todayStr) return;
        lastAutoNoteDate = todayStr;

        // نافذة الدوام الماضية (ليلة أمس): من 22:00 حتى 04:00 بتوقيت الجزائر
        const { start: yesterdayStart, end: yesterdayEnd } = getDutyDayWindow(-1);

        // استثناء الدون وأعضاء العصابات من الملاحظات التلقائية
        const users = await User.find({
            is_blacklisted: false,
            account_status: 'approved',
            role: { $nin: ['Don', 'Gang_Member'] }
        });

        const approvedLeaves = await Leave.find({ status: 'Approved' });

        for (const user of users) {
            const hasLeave = approvedLeaves.some(l => {
                if (l.username !== user.username) return false;
                const leaveStart = new Date(l.timestamp);
                const leaveEnd = new Date(leaveStart);
                leaveEnd.setDate(leaveEnd.getDate() + (l.duration || 1));
                return yesterdayStart < leaveEnd;
            });

            if (hasLeave) {
                if (user.consecutive_misses > 0) {
                    user.consecutive_misses = 0;
                    await user.save();
                }
                continue;
            }

            // التحقق من الحضور عبر سجل البصمات (IN) داخل نافذة الدوام، مع احتياط للبيانات القديمة قبل تفعيل سجل البصمات
            const inPunchCount = await PunchRecord.countDocuments({
                username: user.username,
                action: 'IN',
                timestamp: { $gte: yesterdayStart, $lt: yesterdayEnd }
            });
            const legacyInWindow = user.last_punch_in &&
                user.last_punch_in >= yesterdayStart &&
                user.last_punch_in < yesterdayEnd;
            const wasOnDuty = inPunchCount > 0 || !!legacyInWindow;

            if (wasOnDuty) {
                if (user.consecutive_misses > 0) {
                    user.consecutive_misses = 0;
                    await user.save();
                }
                continue;
            }

            // تسجيل غياب جديد
            user.consecutive_misses = (user.consecutive_misses || 0) + 1;

            await new MemberNote({
                username: user.username,
                reason: MISSED_DUTY_NOTE_TEXT,
                issued_by: 'SYSTEM',
                bill_amount: 0,
                is_auto: true
            }).save();

            // الإنذار الرسمي يُمنح مرة واحدة فقط عند بلوغ 3 غيابات متتالية (وليس مع كل ملاحظة)
            if (user.consecutive_misses === 3) {
                user.warning_dates.push(new Date());
                user.warnings = user.warning_dates.length;

                await new PenaltyLog({
                    target_username: user.username,
                    admin_username: 'SYSTEM',
                    type: 'Warning',
                    reason: `غياب متتالي: ${user.consecutive_misses} أيام بدون تسجيل ON-DUTY`,
                    fine_amount: 0
                }).save();

                if (user.warnings >= 3) {
                    user.is_blacklisted = true;
                    user.duty_status = 'OFF-DUTY';
                    forceUserLogout(user.username);
                }
            }

            await user.save();
        }

        io.emit('notesUpdated');
        io.emit('dutyUpdated', {});
        io.emit('finesUpdated');
    } catch (err) { console.error("Auto-note error:", err.message); }
}, 60000);

// ================== تنظيف الملاحظات التلقائية القديمة (أقدم من 7 أيام) يومياً عند 22:00 بتوقيت الجزائر ==================
setInterval(async () => {
    try {
        const now = new Date();
        const dzNow = new Date(now.getTime() + (60 * 60 * 1000));
        const hours = dzNow.getUTCHours();
        const minutes = dzNow.getUTCMinutes();
        if (hours !== 22 || minutes > 0) return;

        const cutoff = new Date(dzNow.getTime() - 7 * 24 * 60 * 60 * 1000);

        const result = await MemberNote.deleteMany({
            is_auto: true,
            timestamp: { $lt: cutoff }
        });

        if (result.deletedCount > 0) {
            console.log(`Cleaned ${result.deletedCount} auto notes older than 7 days`);
            io.emit('notesUpdated');
        }
    } catch (err) { console.error("Auto-note cleanup error:", err.message); }
}, 60000);

server.listen(PORT, () => console.log("[CORTEZ] Server v8.0 - Notes & Attendance & Inventory Update running on port " + PORT + ""));
