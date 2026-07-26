const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');
// تحديث: مكتبات جديدة مطلوبة — شغّل: npm install multer cloudinary multer-storage-cloudinary
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*" } });

const JWT_SECRET = "CORTEZ_MAFIA_SECURE_KEY_2026";
const PORT = process.env.PORT || 3000;

// الرابط الخاص بقاعدة البيانات
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://moha:cutureire@cluster0.qgk83qz.mongodb.net/cortez?appName=Cluster0';

mongoose.connect(MONGO_URI)
  .then(() => console.log('✓ Connected Strictly to Cortez DB (v8.0 - Notes & Attendance & Inventory Update).'))
  .catch(err => console.error('❌ Database Error:', err));

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ================== تحديث: نظام رفع الصور عبر Cloudinary (تخزين دائم، ما يتأثر بإعادة نشر Render) ==================
// المفاتيح الثلاثة لازم تنحط كـ Environment Variables بلوحة Render (مو بالكود مباشرة، لأسباب أمان)
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
    limits: { fileSize: 5 * 1024 * 1024 } // 5 ميجا كحد أقصى
});

// ================== تحديث: حماية من محاولات الدخول/التسجيل المتكررة (Brute Force) ==================
// ---------------- دوال التنسيق المالي ----------------
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

// ================== تحديث v8.0: دالة فحص نافذة الوقت المسموح فيها بالدخول للخدمة (22:00 - 04:00 بتوقيت الخليج AST/UTC+3) ==================
function isInDutyTimeWindow() {
    const now = new Date();
    // تحويل الوقت إلى توقيت الخليج (AST = UTC+3)
    const gulfTime = new Date(now.getTime() + (3 * 60 * 60 * 1000));
    const hours = gulfTime.getUTCHours();
    const minutes = gulfTime.getUTCMinutes();
    const totalMinutes = hours * 60 + minutes;
    // النافذة المسموحة: من 22:00 (1320 دقيقة) إلى 04:00 (240 دقيقة第二天)
    // ما بين 22:00 (1320) و 23:59 (1439) أو من 00:00 (0) إلى 04:00 (240)
    return totalMinutes >= 1320 || totalMinutes <= 240;
}

// ================== تحديث v8.0: نص الملاحظة الأوتوماتيكية للتغيب عن ON-DUTY ==================
// يمكنك تغيير هذا النص كما يحلو لك
const MISSED_DUTY_NOTE_TEXT = "تم تسجيل غياب - لم يسجل ON-DUTY في الفترة المسموحة";

// ---------------- المخططات (Schemas) ----------------
const UserSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    discord_id: { type: String, required: true },
    role: { type: String, enum: ['Don', 'Underboss', 'Capo', 'Business_Manager', 'Chef_Braquage', 'GRH', 'Soldat', 'Gang_Supervisor', 'Gang_Member'], default: 'Soldat' },
    // تحديث: نظام أعضاء العصابات الخارجيين (منفصل عن أعضاء المافيا)
    gang_name: { type: String, default: '' },
    account_status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'approved' },
    duty_status: { type: String, enum: ['ON-DUTY', 'OFF-DUTY'], default: 'OFF-DUTY' },
    last_punch_in: { type: Date },
    weekly_hours: { type: Number, default: 0 },
    warnings: { type: Number, default: 0 },
    // تحديث: تاريخ كل إنذار على حدة، تُستخدم لحذف الإنذارات تلقائياً بعد مرور شهر عليها
    warning_dates: { type: [Date], default: [] },
    is_blacklisted: { type: Boolean, default: false },
    consecutive_misses: { type: Number, default: 0 },
    total_heists: { type: Number, default: 0 },
    // تحديث v7.7: تتبع الغرامات المالية للعضو
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
    // تحديث: نظام المخزون وحدود الشراء
    in_stock: { type: Boolean, default: true },
    max_per_order: { type: Number, default: null }, // null = بدون حد لكل طلب
    max_per_week: { type: Number, default: null },  // null = بدون حد أسبوعي لكل عضو
    created_by: String,
    timestamp: { type: Date, default: Date.now }
});

const OrderSchema = new mongoose.Schema({
    username: String,
    item_name: String, 
    price: Number,      
    items: Array,
    total_price: Number, 
    status: { type: String, enum: ['Pending', 'Paid'], default: 'Pending' },
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

// ================== تحديث: نظام تتبع العصابات (Gang Tracking) ==================
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
// ملاحظة: ن mantenemos el schema de Gang para compatibilidad مع قاعدة البيانات لكن لا نستخدم الـ Model
const Gang = mongoose.model('Gang', GangSchema);

// ================== تحديث v8.0: نظام الملاحظات ==================
const MemberNoteSchema = new mongoose.Schema({
    username: String,
    reason: String,
    issued_by: String,
    bill_amount: { type: Number, default: 0 },
    is_auto: { type: Boolean, default: false },
    timestamp: { type: Date, default: Date.now }
});

// ================== تحديث v8.0: نظام حساب البزنس مانجر (تسعير الايتمات) ==================
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

// ================== تحديث: نظام شوب أعضاء العصابات (منفصل تماماً عن شوب المافيا) ==================
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
    status: { type: String, enum: ['Pending', 'Confirmed', 'Rejected'], default: 'Pending' },
    rejection_reason: { type: String, default: '' },
    timestamp: { type: Date, default: Date.now }
});

const GangTreasurySchema = new mongoose.Schema({ total_balance: { type: Number, default: 0 } });

// ================== تحديث: تتبع كمية شراء كل عضو من كل منتج هذا الأسبوع (لتطبيق حد "X قطع بالأسبوع") ==================
const WeeklyPurchaseSchema = new mongoose.Schema({
    username: String,
    item_name: String,
    shop_type: { type: String, enum: ['weapon_shop', 'gang_shop'] },
    quantity_bought: { type: Number, default: 0 }
});

// ================== تحديث: سجل تدقيق (Audit Log) يوثق الموافقات وتغيير الرتب ==================
const AuditLogSchema = new mongoose.Schema({
    action: String,
    target_username: String,
    performed_by: String,
    details: { type: String, default: '' },
    timestamp: { type: Date, default: Date.now }
});

const GangShopItem = mongoose.model('GangShopItem', GangShopItemSchema);
const GangOrder = mongoose.model('GangOrder', GangOrderSchema);
const GangTreasury = mongoose.model('GangTreasury', GangTreasurySchema);
const WeeklyPurchase = mongoose.model('WeeklyPurchase', WeeklyPurchaseSchema);
const AuditLog = mongoose.model('AuditLog', AuditLogSchema);

async function initSystemDB() {
    try {
        const treasuryCount = await Treasury.countDocuments({});
        if (treasuryCount === 0) { await new Treasury({ total_balance: 0 }).save(); }

        // تحديث: تهيئة خزينة شوب العصابات المستقلة
        const gangTreasuryCount = await GangTreasury.countDocuments({});
        if (gangTreasuryCount === 0) { await new GangTreasury({ total_balance: 0 }).save(); }
    } catch (err) {
        console.error("Initialization warning:", err.message);
    }
}
initSystemDB();

// ---------------- نظام الصلاحيات المطور ----------------
const verifyAuth = (roles) => {
    return (req, res, next) => {
        const token = req.headers['authorization']?.split(' ')[1];
        if (!token) return res.status(401).json({ error: "غير مصرح بالدخول." });
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            const hasAccess = roles.includes(decoded.role) || decoded.role === 'Don';
            if (!hasAccess) return res.status(403).json({ error: "رتبتك لا تسمح بالدخول إلى هذا القسم." });
            req.user = decoded; next();
        } catch { res.status(400).json({ error: "جلسة العمل منتهية أو التوكن غير صالح." }); }
    }
};

// ================== مسارات النظام الأساسية ==================

// تحديث: رفع صورة مباشرة عبر Cloudinary (رابط دائم لا يختفي بعد إعادة نشر Render)
app.post('/api/upload-image', verifyAuth(['Underboss', 'Business_Manager', 'Gang_Supervisor', 'Don']), (req, res) => {
    imageUpload.single('image')(req, res, (err) => {
        if (err) return res.status(400).json({ error: err.message || "فشل رفع الصورة." });
        if (!req.file) return res.status(400).json({ error: "لم يتم اختيار أي ملف." });
        res.json({ url: req.file.path });
    });
});

app.post('/api/auth/register', async (req, res) => {
    try {
        const { username, password, discord_id } = req.body;
        if (!discord_id) return res.status(400).json({ error: "حقل الـ Discord ID مطلوب." });
        const hashedPassword = await bcrypt.hash(password, 10);
        const isFirstUser = (await User.countDocuments({})) === 0;
        const newUser = new User({
            username, password: hashedPassword, discord_id: String(discord_id),
            role: isFirstUser ? 'Don' : 'Soldat',
            account_status: isFirstUser ? 'approved' : 'pending'
        });
        await newUser.save();
        if (!isFirstUser) io.emit('accountPending');
        res.status(201).json({ msg: isFirstUser ? `تم التسجيل بنجاح.` : "تم إرسال طلبك بنجاح. يرجى انتظار موافقة قيادة المافيا لتفعيل حسابك." });
    } catch (err) { res.status(400).json({ error: "اسم المستخدم مسجل مسبقاً بالتنظيم." }); }
});

// ================== تحديث: تسجيل جديد ومنفصل لأعضاء العصابات (يحتاج موافقة GRH أو الدون) ==================
app.post('/api/gang-auth/register', async (req, res) => {
    try {
        const { username, password, gang_name, discord_id } = req.body;
        if (!username || !password || !gang_name) return res.status(400).json({ error: "اسم المستخدم وكلمة المرور واسم العصابة كلها مطلوبة." });

        const existing = await User.findOne({ username });
        if (existing) return res.status(400).json({ error: "اسم المستخدم مستخدم مسبقاً." });

        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = new User({
            username, password: hashedPassword, discord_id: discord_id ? String(discord_id) : 'N/A',
            role: 'Gang_Member', gang_name, account_status: 'pending'
        });
        await newUser.save();
        io.emit('accountPending');
        res.status(201).json({ msg: "تم إرسال طلبك بنجاح. يرجى انتظار موافقة قيادة المافيا لتفعيل حسابك." });
    } catch (err) { res.status(400).json({ error: "حدث خطأ أثناء التسجيل، تأكد من اسم المستخدم." }); }
});

// جلب أسماء العصابات المسجلة (للقراءة فقط - يُستخدم عند التسجيل لاقتراح الأسماء)
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
        if (!user || !(await bcrypt.compare(password, user.password))) return res.status(400).json({ error: "خطأ في اسم المستخدم أو كلمة المرور." });
        if (user.is_blacklisted) return res.status(403).json({ error: "تم حظرك ومطاردتك من عائلة كورتيز (بلاك ليست)." });

        if (user.account_status === 'pending') return res.status(403).json({ error: "حسابك لسا بانتظار موافقة قيادة المافيا. حاول لاحقاً." });
        if (user.account_status === 'rejected') return res.status(403).json({ error: "تم رفض طلب انضمامك لهذا النظام." });
        
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
        res.json(user);
    } catch { res.status(401).json({ error: "جلسة منتهية" }); }
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
        res.status(201).json({ msg: "تم إضافة الآيتم بنجاح إلى الشوب الرئاسي." });
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
        res.json({ msg: "تم تعديل المنتج بنجاح." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/shop/item/:id', verifyAuth(['Underboss', 'Business_Manager']), async (req, res) => {
    try {
        await Item.findByIdAndDelete(req.params.id);
        io.emit('shopUpdated');
        res.json({ msg: "تم حذف المنتج بنجاح." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/shop/checkout', verifyAuth(['Underboss', 'Soldat', 'GRH', 'Chef_Braquage', 'Business_Manager', 'Gang_Supervisor']), async (req, res) => {
    try {
        const { items } = req.body;
        if (!items || items.length === 0) return res.status(400).json({ error: "السلة فارغة." });

        const username = req.user.username;
        let total_price = 0;
        const processedItems = [];

        for (const i of items) {
            const dbItem = await Item.findOne({ name: i.name });
            if (!dbItem) return res.status(400).json({ error: `المنتج "${i.name}" غير موجود.` });
            if (!dbItem.in_stock) return res.status(400).json({ error: `المنتج "${i.name}" نفذت كميته حالياً (Out of Stock).` });

            const qty = Math.max(1, parseInt(i.quantity) || 1);
            if (dbItem.max_per_order && qty > dbItem.max_per_order) {
                return res.status(400).json({ error: `الحد الأقصى لمنتج "${i.name}" بالطلب الواحد هو ${dbItem.max_per_order} قطعة.` });
            }

            if (dbItem.max_per_week) {
                const record = await WeeklyPurchase.findOne({ username, item_name: i.name, shop_type: 'weapon_shop' });
                const alreadyBought = record ? record.quantity_bought : 0;
                if (alreadyBought + qty > dbItem.max_per_week) {
                    const remaining = Math.max(0, dbItem.max_per_week - alreadyBought);
                    return res.status(400).json({ error: `وصلت للحد الأسبوعي لمنتج "${i.name}" (${dbItem.max_per_week} بالأسبوع). المتبقي لك: ${remaining}.` });
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
        res.json({ msg: "تم رفع طلبك للإدارة بنجاح، يرجى تسليم المبلغ داخل المدينة." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/shop/orders', verifyAuth(['Underboss', 'Business_Manager', 'Chef_Braquage', 'GRH']), async (req, res) => {
    try { const orders = await Order.find().sort({ timestamp: -1 }); res.json(orders); } 
    catch (err) { res.status(500).json({ error: err.message }); }
});

const confirmPaymentLogic = async (req, res) => {
    try {
        const order_id = req.params.id || req.body.order_id;
        if (!order_id) return res.status(400).json({ error: "رقم الطلب غير موجود." });

        const order = await Order.findById(order_id);
        if (!order || order.status === 'Paid') return res.status(400).json({ error: "الطلب غير صحيح أو مدفوع مسبقاً." });
        
        order.status = 'Paid';
        await order.save();
        
        const amountToAdd = order.total_price || order.price; 
        await Treasury.updateOne({}, { $inc: { total_balance: amountToAdd } });
        
        io.emit('ordersUpdated'); io.emit('treasuryUpdated');
        res.json({ msg: "تم تأكيد الدفع وإضافة المبلغ إلى الخزينة العليا للعصابة." });
    } catch (err) { res.status(500).json({ error: err.message }); }
};

app.post('/api/shop/order/:id/pay', verifyAuth(['Underboss', 'Business_Manager']), confirmPaymentLogic);
app.put('/api/shop/order/:id/pay', verifyAuth(['Underboss', 'Business_Manager']), confirmPaymentLogic);

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
        res.json({ msg: "تم تصفير الخزينة بالكامل بناءً على أوامر القيادة العليا." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/shop/invoice/:id', async (req, res) => {
    try {
        const order = await Order.findById(req.params.id);
        if (!order) return res.status(404).send("الطلب غير موجود");
        
        let itemsList = '';
        if (order.items && order.items.length > 0) {
            itemsList = order.items.map(i => {
                const qty = i.quantity || 1;
                return `<li>${qty}x ${i.name} - ${formatMoneyExact(i.total || (i.price * qty))}$</li>`;
            }).join('');
        } else { itemsList = `<li>1x ${order.item_name} - ${formatMoneyExact(order.price)}$</li>`; }

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
                    <p><b>معرف العملية (ID):</b> ${order._id}</p>
                    <p><b>العميل المستلم:</b> ${order.username}</p>
                    <p><b>تاريخ الإصدار:</b> ${new Date(order.timestamp).toLocaleString('en-GB')}</p>
                    <p><b>حالة السداد:</b> ${order.status === 'Paid' ? '<span style="color:#00ff66;">مكتمل ومدفوع بالكامل ✔️</span>' : '<span style="color:red;">معلق ❌</span>'}</p>
                </div>
                <hr>
                <ul>${itemsList}</ul>
                <div class="total">الإجمالي النهائي: ${total}$</div>
                ${order.status === 'Paid' ? '<div class="stamp">AUTHORIZED & PAID</div>' : ''}
            </div>
        </body>
        </html>`;
        res.send(html);
    } catch (err) { res.status(500).send("خطأ في جلب الفاتورة: " + err.message); }
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
        if (new_role === 'Don') return res.status(403).json({ error: "لا يمكن منح رتبة البوس (Don) لأي شخص!" });
        const oldUser = await User.findOne({ username: target_username }, 'role');
        await User.findOneAndUpdate({ username: target_username }, { role: new_role });
        await new AuditLog({
            action: 'role_changed', target_username, performed_by: req.user.username,
            details: `من ${oldUser ? oldUser.role : '؟'} إلى ${new_role}`
        }).save();
        io.emit('dutyUpdated', {}); io.emit('auditLogUpdated');
        res.json({ msg: `تم تحديث الرتبة بنجاح.` });
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
        res.json({ msg: `تم تغيير كلمة مرور "${target_username}" بنجاح. أبلغه بكلمة المرور الجديدة يدوياً.` });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/adjust-hours', verifyAuth(['Underboss', 'GRH']), async (req, res) => {
    try {
        const { target_username, new_hours } = req.body;
        if (new_hours === undefined || new_hours === '' || isNaN(new_hours) || Number(new_hours) < 0) {
            return res.status(400).json({ error: "الرجاء إدخال رقم ساعات صحيح (0 أو أكبر)." });
        }
        const newMinutes = Math.round(Number(new_hours) * 60);
        const result = await User.findOneAndUpdate(
            { username: target_username },
            { weekly_hours: newMinutes, duty_status: 'OFF-DUTY' }
        );
        if (!result) return res.status(404).json({ error: "العضو غير موجود." });

        await new AuditLog({
            action: 'hours_adjusted', target_username, performed_by: req.user.username,
            details: `تصحيح الساعات إلى ${new_hours} ساعة (وإرجاعه OFF-DUTY تلقائياً)`
        }).save();
        io.emit('dutyUpdated', {});
        io.emit('auditLogUpdated');
        res.json({ msg: `تم تصحيح ساعات "${target_username}" إلى ${new_hours} ساعة، ورجّعناه OFF-DUTY.` });
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
        res.json({ msg: "تمت أرشفة الأسبوع بنجاح وتصفير الساعات وحدود الشراء لبدء دورة جديدة." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/archive', verifyAuth(['Underboss', 'GRH']), async (req, res) => {
    try { const archives = await Archive.find().sort({ week_date: -1 }); res.json(archives); } 
    catch (err) { res.status(500).json({ error: err.message }); }
});

// ================== تحديث v7.7: نظام العقوبات المطور والغرامات المالية ==================
app.post('/api/admin/penalty', verifyAuth(['Underboss', 'GRH']), async (req, res) => {
    try {
        const { target_username, type, reason, fine_amount } = req.body;
        const user = await User.findOne({ username: target_username });
        if (!user) return res.status(404).json({ error: "المستخدم غير موجود." });

        let penaltyAmount = 0;

        if (type === 'Warning') {
            user.warning_dates.push(new Date());
            user.warnings = user.warning_dates.length;
            if (user.warnings >= 3) user.is_blacklisted = true;
        } else if (type === 'Blacklist') {
            user.is_blacklisted = true; user.duty_status = 'OFF-DUTY';
        } else if (type === 'Remove_Blacklist') {
            user.is_blacklisted = false; user.warnings = 0; user.warning_dates = [];
        } else if (type === 'Fine') {
            penaltyAmount = Number(fine_amount || 0);
            if (penaltyAmount <= 0) return res.status(400).json({ error: "يرجى تحديد مبلغ الغرامة بشكل صحيح." });
            user.fine_amount += penaltyAmount;
            user.fine_reason = reason || "مخالفة القوانين الداخلية";
        }
        
        await user.save();
        await new PenaltyLog({ target_username, admin_username: req.user.username, type, reason, fine_amount: penaltyAmount }).save();
        
        io.emit('dutyUpdated', { username: user.username, duty_status: user.duty_status });
        io.emit('finesUpdated');
        io.emit('notesUpdated');
        
        res.json({ msg: "تم تطبيق الإجراء الإداري وتدوينه بنجاح." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// جلب قائمة الأشخاص الذين عليهم غرامات فقط (لجدول الإدارة)
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
        if (!user || user.fine_amount <= 0) return res.status(400).json({ error: "المستخدم ليس لديه أي غرامة معلقة." });

        const amountPaid = user.fine_amount;
        
        user.fine_amount = 0;
        user.fine_reason = "";
        await user.save();

        await Treasury.updateOne({}, { $inc: { total_balance: amountPaid } });

        io.emit('finesUpdated');
        io.emit('treasuryUpdated');
        io.emit('dutyUpdated');
        
        res.json({ msg: `تم تسوية الغرامة بنجاح، وتحويل مبلغ ${amountPaid}$ مباشرة إلى خزينة العصابة.` });
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

app.post('/api/hr/leave', verifyAuth(['Underboss', 'Soldat', 'GRH', 'Chef_Braquage', 'Business_Manager', 'Gang_Supervisor']), async (req, res) => {
    try {
        await new Leave({ username: req.user.username, reason: req.body.reason, duration: Number(req.body.duration) }).save();
        io.emit('requestUpdated'); res.json({ msg: "تم رفع طلب الإجازة بنجاح." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/hr/justify', verifyAuth(['Underboss', 'Soldat', 'GRH', 'Chef_Braquage', 'Business_Manager', 'Gang_Supervisor']), async (req, res) => {
    try {
        await new Justification({ username: req.user.username, reason: req.body.reason }).save();
        io.emit('requestUpdated'); res.json({ msg: "تم رفع تبرير الغياب بنجاح." });
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
            // تحديث v8.0: عند الموافقة على الإجازة، إنشاء ملاحظة تلقائية للعضو
            if (action === 'Approved') {
                const leave = await Leave.findById(id);
                if (leave) {
                    await new MemberNote({
                        username: leave.username,
                        reason: `تمت الموافقة على إجازة: ${leave.reason} لمدة ${leave.duration} أيام`,
                        issued_by: req.user.username,
                        bill_amount: 0
                    }).save();
                    io.emit('notesUpdated');
                }
            }
        }
        if (type === 'justify') await Justification.findByIdAndUpdate(id, { status: action });
        io.emit('requestUpdated'); res.json({ msg: "تم تحديث حالة الطلب والبت فيه." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ================== تحديث v8.0: نظام الملاحظات ==================
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

app.get('/api/notes/my', verifyAuth(['Underboss', 'Soldat', 'GRH', 'Chef_Braquage', 'Business_Manager', 'Gang_Supervisor']), async (req, res) => {
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
        if (!username || !reason) return res.status(400).json({ error: "اسم المستخدم والسب مطلوبان." });

        const note = new MemberNote({
            username,
            reason,
            issued_by: req.user.username,
            bill_amount: Number(bill_amount || 0)
        });
        await note.save();

        // تحقق: إذا وصل العضو إلى 3 ملاحظات أو أكثر، يُصدر له إنذار تلقائي
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
                    reason: `إنذار تلقائي: وصل ${totalNotes} ملاحظات`,
                    fine_amount: 0
                }).save();
            }
        }

        io.emit('notesUpdated');
        io.emit('dutyUpdated');
        io.emit('finesUpdated');

        let msg = "تمت إضافة الملاحظة بنجاح.";
        if (warningsIssued) msg += ` (${username} وصل إلى 3 ملاحظات، تم إنذاره تلقائياً.`;
        if (blacklisted) msg += ` تم حظره (بلاك ليست) بعد 3 إنذارات.)`;
        else if (warningsIssued) msg += ")";

        res.status(201).json({ msg, total_notes: totalNotes });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ================== تحديث v8.0: حذف ملاحظة ==================
app.delete('/api/notes/:id', verifyAuth(['Don', 'Underboss', 'GRH']), async (req, res) => {
    try {
        const note = await MemberNote.findByIdAndDelete(req.params.id);
        if (!note) return res.status(404).json({ error: "الملاحظة غير موجودة." });
        io.emit('notesUpdated');
        res.json({ msg: "تم حذف الملاحظة بنجاح." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ================== تحديث v8.0: نظام الحضور اليومي ==================
app.get('/api/attendance/today', verifyAuth(['Don', 'Underboss', 'GRH', 'Business_Manager']), async (req, res) => {
    try {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);

        // جلب كل الأعضاء المعتمدين (غير محظورين، غير أعضاء عصابات)
        const members = await User.find({
            is_blacklisted: false,
            account_status: 'approved',
            role: { $ne: 'Gang_Member' }
        }, 'username role duty_status last_punch_in weekly_hours');

        const attendance = members.map(u => {
            let was_on_today = false;
            let last_punch_in = u.last_punch_in ? u.last_punch_in.toISOString() : null;

            if (u.last_punch_in) {
                const punchIn = new Date(u.last_punch_in);
                if (punchIn >= today && punchIn < tomorrow) {
                    was_on_today = true;
                }
            }

            return {
                username: u.username,
                role: u.role,
                duty_status: u.duty_status,
                was_on_today,
                last_punch_in
            };
        });

        res.json(attendance);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ================== تحديث v8.0: نظام المخزون / حساب البزنس مانجر ==================
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
        res.status(201).json({ msg: "تمت إضافة المنتج إلى المخزون بنجاح." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/inventory/items', verifyAuth(['Underboss', 'Soldat', 'GRH', 'Chef_Braquage', 'Business_Manager', 'Gang_Supervisor']), async (req, res) => {
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
        res.json({ msg: "تم تعديل المنتج بنجاح." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/inventory/item/:id', verifyAuth(['Don', 'Underboss', 'Business_Manager']), async (req, res) => {
    try {
        await InventoryItem.findByIdAndDelete(req.params.id);
        io.emit('inventoryUpdated');
        res.json({ msg: "تم حذف المنتج من المخزون بنجاح." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ================== تحديث: الموافقة على أي حساب جديد معلّق (مافيا أو عصابة) — GRH أو الدون ==================
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
        if (!user) return res.status(404).json({ error: "الحساب غير موجود أو تمت مراجعته مسبقاً." });

        user.account_status = decision === 'approve' ? 'approved' : 'rejected';
        await user.save();
        await new AuditLog({
            action: decision === 'approve' ? 'account_approved' : 'account_rejected',
            target_username, performed_by: req.user.username,
            details: user.role === 'Gang_Member' ? `عضو عصابة: ${user.gang_name}` : 'عضو مافيا'
        }).save();
        io.emit('accountPending'); io.emit('auditLogUpdated');
        res.json({ msg: decision === 'approve' ? `تم تفعيل حساب ${target_username} بنجاح.` : `تم رفض طلب ${target_username}.` });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ================== تحديث: شوب أعضاء العصابات (منفصل كلياً عن شوب المافيا) ==================
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
        if ((finalType === 'buy_only' || finalType === 'both') && !buy_price) return res.status(400).json({ error: "سعر الشراء مطلوب لهذا النوع من المنتجات." });
        if ((finalType === 'sell_only' || finalType === 'both') && !sell_price) return res.status(400).json({ error: "سعر البيع مطلوب لهذا النوع من المنتجات." });

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
        res.json({ msg: "تم تعديل المنتج بنجاح." });
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
            return res.status(400).json({ error: "لم يتم تحديد أي منتج للشراء أو البيع." });
        }

        const catalog = await GangShopItem.find();
        const findItem = (name) => catalog.find(c => c.name === name);
        const username = req.user.username;

        let total_buy_value = 0;
        const processedBought = [];
        for (const i of (items_bought || [])) {
            const catalogItem = findItem(i.name);
            if (!catalogItem) throw new Error(`المنتج "${i.name}" غير موجود بالكتالوج.`);
            if (catalogItem.item_type === 'sell_only') throw new Error(`المنتج "${i.name}" غير متاح للشراء (خاص بالبيع فقط).`);
            if (!catalogItem.in_stock) throw new Error(`المنتج "${i.name}" نفذت كميته حالياً (Out of Stock).`);

            const qty = Math.max(1, parseInt(i.quantity) || 1);
            if (qty > MAX_QTY_PER_LINE) throw new Error(`الكمية المطلوبة لـ "${i.name}" كبيرة جداً، تأكد من الرقم.`);
            if (catalogItem.max_per_order && qty > catalogItem.max_per_order) {
                throw new Error(`الحد الأقصى لمنتج "${i.name}" بالطلب الواحد هو ${catalogItem.max_per_order} قطعة.`);
            }
            if (catalogItem.max_per_week) {
                const record = await WeeklyPurchase.findOne({ username, item_name: i.name, shop_type: 'gang_shop' });
                const alreadyBought = record ? record.quantity_bought : 0;
                if (alreadyBought + qty > catalogItem.max_per_week) {
                    const remaining = Math.max(0, catalogItem.max_per_week - alreadyBought);
                    throw new Error(`وصلت للحد الأسبوعي لمنتج "${i.name}" (${catalogItem.max_per_week} بالأسبوع). المتبقي لك: ${remaining}.`);
                }
            }

            const total = catalogItem.buy_price * qty;
            total_buy_value += total;
            processedBought.push({ name: i.name, quantity: qty, unit_price: catalogItem.buy_price, total, max_per_week: catalogItem.max_per_week });
        }

        let total_sell_value = 0;
        const processedSold = (items_sold || []).map(i => {
            const catalogItem = findItem(i.name);
            if (!catalogItem) throw new Error(`المنتج "${i.name}" غير موجود بالكتالوج.`);
            if (catalogItem.item_type === 'buy_only') throw new Error(`المنتج "${i.name}" غير متاح للبيع (خاص بالشراء فقط).`);
            const qty = Math.max(1, parseInt(i.quantity) || 1);
            if (qty > MAX_QTY_PER_LINE) throw new Error(`الكمية المطلوبة لـ "${i.name}" كبيرة جداً، تأكد من الرقم.`);
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
        res.status(201).json({ msg: "تم رفع طلبك للإدارة، يرجى إتمام التسليم داخل المدينة مع مسؤول العصابات." });
    } catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/api/gang-shop/my-orders', verifyAuth(['Gang_Member']), async (req, res) => {
    try {
        const orders = await GangOrder.find({ gang_member_username: req.user.username }).sort({ timestamp: -1 });
        res.json(orders);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/gang-shop/orders', verifyAuth(['Underboss', 'Business_Manager']), async (req, res) => {
    try { const orders = await GangOrder.find().sort({ timestamp: -1 }); res.json(orders); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/gang-shop/order/:id/confirm', verifyAuth(['Underboss', 'Business_Manager']), async (req, res) => {
    try {
        const order = await GangOrder.findById(req.params.id);
        if (!order || order.status !== 'Pending') return res.status(400).json({ error: "الطلب غير موجود أو تمت معالجته مسبقاً." });

        order.status = 'Confirmed';
        await order.save();
        await GangTreasury.updateOne({}, { $inc: { total_balance: order.net_amount } });

        io.emit('gangOrdersUpdated'); io.emit('gangTreasuryUpdated');
        res.json({ msg: "تم تأكيد إتمام العملية وتحديث خزينة شوب العصابات." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/gang-shop/order/:id/reject', verifyAuth(['Underboss', 'Business_Manager']), async (req, res) => {
    try {
        const { reason } = req.body;
        const order = await GangOrder.findById(req.params.id);
        if (!order || order.status !== 'Pending') return res.status(400).json({ error: "الطلب غير موجود أو تمت معالجته مسبقاً." });

        order.status = 'Rejected';
        order.rejection_reason = reason || '';
        await order.save();
        io.emit('gangOrdersUpdated');
        res.json({ msg: "تم رفض الطلب." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/gang-shop/treasury', verifyAuth(['Underboss', 'Business_Manager']), async (req, res) => {
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
        res.json({ msg: "تم تصفير خزينة شوب العصابات بالكامل." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// صائد الأخطاء
app.use('/api', (req, res) => {
    res.status(404).json({ error: "المسار غير موجود أو نوع الطلب خاطئ: " + req.originalUrl });
});

// ---------------- Sockets ----------------
io.on('connection', (socket) => {
    socket.on('triggerEmergency', (data) => {
        io.emit('emergencyAlert', { 
            message: "🚨 استنفار عام داخل النظام! جميع الأعضاء التوجه للديسكورد فوراً.",
            sender: data.username 
        });
    });

    socket.on('toggleDuty', async (data) => {
        try {
            const user = await User.findOne({ username: data.username, is_blacklisted: false });
            if (!user) return;
            const now = new Date();
            if (user.duty_status === 'OFF-DUTY') {
                // تحديث v8.0: التحقق من نافذة الوقت المسموحة (22:00 - 04:00 بتوقيت الخليج)
                if (!isInDutyTimeWindow()) {
                    socket.emit('statusResponse', { error: "لا يمكنك الدخول للخدمة خارج النافذة المسموحة (22:00 - 04:00 بتوقيت الخليج)." });
                    return;
                }
                user.duty_status = 'ON-DUTY'; user.last_punch_in = now;
            } else {
                if (user.last_punch_in) user.weekly_hours += Math.floor((now - user.last_punch_in) / 60000);
                user.duty_status = 'OFF-DUTY';
            }
            await user.save();
            io.emit('dutyUpdated', { username: user.username, duty_status: user.duty_status });
            io.emit('attendanceUpdated');
            socket.emit('statusResponse', { username: user.username, duty_status: user.duty_status });
        } catch (err) { console.error(err.message); }
    });
});

// ================== تحديث v8.0: فحص دوري كل 5 دقائق لإطفاء أي عضو ON-DUTY خارج النافذة المسموحة ==================
setInterval(async () => {
    try {
        // إطفاء تلقائي لأي عضو ON-DUTY خارج نافذة الوقت 22:00-04:00
        if (!isInDutyTimeWindow()) {
            const activeUsers = await User.find({ duty_status: 'ON-DUTY' });
            for (let u of activeUsers) {
                if (u.last_punch_in) u.weekly_hours += Math.floor((new Date() - u.last_punch_in) / 60000);
                u.duty_status = 'OFF-DUTY';
                await u.save();
            }
            if (activeUsers.length > 0) { io.emit('dutyUpdated', {}); io.emit('attendanceUpdated'); }
        }

        // الحماية القصوى: إطفاء أي عضو تجاوز 8 ساعات متواصلة
        const allActiveUsers = await User.find({ duty_status: 'ON-DUTY' });
        const maxTimeMs = 8 * 60 * 60 * 1000; 
        const now = new Date();
        let stateChanged = false;

        for (let u of allActiveUsers) {
            if (u.last_punch_in && (now - u.last_punch_in > maxTimeMs)) {
                u.weekly_hours += Math.floor(maxTimeMs / 60000);
                u.duty_status = 'OFF-DUTY';
                await u.save();
                stateChanged = true;
            }
        }
        if (stateChanged) { io.emit('dutyUpdated', {}); io.emit('attendanceUpdated'); }
    } catch (err) { console.error(err.message); }
}, 300000); 

// ================== تحديث: حذف الإنذارات (Warnings) تلقائياً بعد مرور شهر عليها ==================
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
    } catch (err) { console.error("خطأ في تنظيف الإنذارات المنتهية:", err.message); }
}

setInterval(cleanupExpiredWarnings, 3600000);
cleanupExpiredWarnings();

// ================== تحديث v8.0: الفحص الدوري لإصدار ملاحظات التغيب الأوتوماتيكية عند 04:00 بتوقيت الخليج ==================
setInterval(async () => {
    try {
        const now = new Date();
        const gulfNow = new Date(now.getTime() + (3 * 60 * 60 * 1000));
        const hours = gulfNow.getUTCHours();
        const minutes = gulfNow.getUTCMinutes();
        if (hours !== 4 || minutes > 5) return;

        const yesterdayStart = new Date(gulfNow);
        yesterdayStart.setDate(yesterdayStart.getDate() - 1);
        yesterdayStart.setUTCHours(22, 0, 0, 0);
        const yesterdayEnd = new Date(gulfNow);
        yesterdayEnd.setUTCHours(4, 0, 0, 0);

        const users = await User.find({
            is_blacklisted: false,
            account_status: 'approved',
            role: { $ne: 'Gang_Member' }
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

            const wasOnDuty = user.last_punch_in &&
                user.last_punch_in >= yesterdayStart &&
                user.last_punch_in <= yesterdayEnd;

            if (wasOnDuty) {
                if (user.consecutive_misses > 0) {
                    user.consecutive_misses = 0;
                    await user.save();
                }
                continue;
            }

            user.consecutive_misses = (user.consecutive_misses || 0) + 1;

            await new MemberNote({
                username: user.username,
                reason: MISSED_DUTY_NOTE_TEXT,
                issued_by: 'SYSTEM',
                bill_amount: 0,
                is_auto: true
            }).save();

            if (user.consecutive_misses >= 3) {
                user.warning_dates.push(new Date());
                user.warnings = user.warning_dates.length;

                await new PenaltyLog({
                    target_username: user.username,
                    admin_username: 'SYSTEM',
                    type: 'Warning',
                    reason: `إنذار تلقائي: ${user.consecutive_misses} أيام متتالية بدون ON-DUTY`,
                    fine_amount: 0
                }).save();

                if (user.warnings >= 3) {
                    user.is_blacklisted = true;
                    user.duty_status = 'OFF-DUTY';
                }
            }

            await user.save();
        }

        io.emit('notesUpdated');
        io.emit('dutyUpdated', {});
        io.emit('finesUpdated');
    } catch (err) { console.error("Auto-note error:", err.message); }
}, 60000);

// ================== تحديث v8.0: تنظيف الملاحظات الأوتوماتيكية عند 22:00 بتوقيت الخليج ==================
setInterval(async () => {
    try {
        const now = new Date();
        const gulfNow = new Date(now.getTime() + (3 * 60 * 60 * 1000));
        const hours = gulfNow.getUTCHours();
        const minutes = gulfNow.getUTCMinutes();
        if (hours !== 22 || minutes > 5) return;

        const cutoff = new Date(gulfNow);
        cutoff.setUTCHours(22, 0, 0, 0);

        const result = await MemberNote.deleteMany({
            is_auto: true,
            timestamp: { $lt: cutoff }
        });

        if (result.deletedCount > 0) {
            console.log(`Cleaned ${result.deletedCount} auto notes at 22:00 AST`);
            io.emit('notesUpdated');
        }
    } catch (err) { console.error("Auto-note cleanup error:", err.message); }
}, 60000);

// ================== تحديث v8.0: إزالة إنذار من عضو ==================
app.post('/api/admin/remove-warning', verifyAuth(['Don', 'Underboss', 'GRH']), async (req, res) => {
    try {
        const { target_username } = req.body;
        const user = await User.findOne({ username: target_username });
        if (!user) return res.status(404).json({ error: "المستخدم غير موجود." });
        if (user.warnings <= 0) return res.status(400).json({ error: "المستخدم ليس لديه أي إنذارات." });

        if (user.warning_dates.length > 0) user.warning_dates.shift();
        user.warnings = user.warning_dates.length;
        await user.save();

        await new AuditLog({
            action: 'warning_removed',
            target_username,
            performed_by: req.user.username,
            details: `إزالة إنذار واحد (المتبقي: ${user.warnings})`
        }).save();

        io.emit('dutyUpdated', {});
        io.emit('auditLogUpdated');
        res.json({ msg: `تم إزالة إنذار واحد من "${target_username}". الإنذارات المتبقية: ${user.warnings}` });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ================== تحديث v8.0: جلب الأعضاء الذين لديهم إنذارات ==================
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

server.listen(PORT, () => console.log("[CORTEZ] Server v8.0 - Notes & Attendance & Inventory Update running on port " + PORT + ""));
