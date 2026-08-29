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
const { isInDutyTimeWindow, algeriaNow, getDutyDayWindow, buildDutyWeekDays } = require('./server/shared/time');
const { ROLES, ROLE_GROUPS } = require('./server/shared/roles');
const logger = require('./server/shared/logger');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: process.env.CORS_ORIGIN || "http://localhost:3000" } });

const JWT_SECRET = process.env.JWT_SECRET || 'CORTEZ_MAFIA_SECURE_KEY_2026';
const PORT = process.env.PORT || 3000;

// الاتصال بقاعدة بيانات MongoDB
const MONGO_URI = process.env.MONGO_URI;

if (!MONGO_URI) { logger.error('MONGO_URI غير معرف. يرجى ضبط متغير البيئة MONGO_URI.'); logger.flushSync(); process.exit(1); }
mongoose.connect(MONGO_URI)
  .then(() => logger.log('تم الاتصال بقاعدة بيانات CORTEZ (v8.0 - الملاحظات والحضور والمخزون).'))
  .catch(err => logger.error('خطأ في الاتصال بقاعدة البيانات: ' + (err && err.message ? err.message : err)));

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
    is_blacklisted: { type: Boolean, default: false },
    consecutive_misses: { type: Number, default: 0 },
    total_heists: { type: Number, default: 0 }
});

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
const Item = mongoose.model('Item', ItemSchema);
const Order = mongoose.model('Order', OrderSchema);
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
const WeeklyPurchase = mongoose.model('WeeklyPurchase', WeeklyPurchaseSchema);
const AuditLog = mongoose.model('AuditLog', AuditLogSchema);
const PunchRecord = mongoose.model('PunchRecord', PunchRecordSchema);

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
                const hasAccess = roles.includes(decoded.role) || decoded.role === ROLES.DON;
                if (!hasAccess) return res.status(403).json({ error: "ليست لديك صلاحية الوصول لهذه الميزة." });
                next();
            }).catch(() => res.status(500).json({ error: "خطأ في معالجة الطلب." }));
        } catch { res.status(400).json({ error: "انتهت صلاحية التوكن أو أنه غير صالح." }); }
    }
};

// ================== مسارات الواجهة البرمجية ==================

// رفع الصور إلى Cloudinary (متاح للقيادة وأصحاب الصلاحيات فقط)
app.post('/api/upload-image', verifyAuth([ROLES.UNDERBOSS, ROLES.BUSINESS_MANAGER, ROLES.GANG_SUPERVISOR, ROLES.DON]), (req, res) => {
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
            role: isFirstUser ? ROLES.DON : ROLES.SOLDAT,
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
            role: ROLES.GANG_MEMBER, gang_name, account_status: 'pending'
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
        res.json({ token, user: { username: user.username, role: user.role, gang_name: user.gang_name, duty_status: user.duty_status } });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/auth/me', async (req, res) => {
    try {
        const token = req.headers['authorization']?.split(' ')[1];
        if (!token) return res.status(401).json({ error: "غير مصرح" });
        const decoded = jwt.verify(token, JWT_SECRET);
        const user = await User.findById(decoded.id, 'username role duty_status');
        if (!user) return res.status(401).json({ error: "حسابك لم يعد موجوداً", forceLogout: true });
        res.json(user);
    } catch { res.status(401).json({ error: "انتهت الجلسة" }); }
});

app.get('/api/users/list', verifyAuth([ROLES.UNDERBOSS, ROLES.CHEF_BRAQUAGE, ROLES.BUSINESS_MANAGER, ROLES.DON]), async (req, res) => {
    try {
        const users = await User.find({ account_status: 'approved', role: { $ne: ROLES.GANG_MEMBER } }, 'username is_blacklisted');
        res.json(users);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/shop/items', async (req, res) => {
    try { const items = await Item.find().sort({ timestamp: -1 }); res.json(items); } 
    catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/shop/add-item', verifyAuth(ROLE_GROUPS.SHOP_MANAGER), async (req, res) => {
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

app.put('/api/shop/item/:id', verifyAuth(ROLE_GROUPS.SHOP_MANAGER), async (req, res) => {
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

app.delete('/api/shop/item/:id', verifyAuth(ROLE_GROUPS.SHOP_MANAGER), async (req, res) => {
    try {
        await Item.findByIdAndDelete(req.params.id);
        io.emit('shopUpdated');
        res.json({ msg: "تم حذف المنتج بنجاح." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/shop/checkout', verifyAuth(ROLE_GROUPS.MEMBERS), async (req, res) => {
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

app.get('/api/shop/orders', verifyAuth([ROLES.DON, ROLES.UNDERBOSS, ROLES.BUSINESS_MANAGER, ROLES.CHEF_BRAQUAGE, ROLES.GRH]), async (req, res) => {
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
        
        io.emit('ordersUpdated');
        res.json({ msg: "تم تأكيد استلام المبلغ بنجاح." });
    } catch (err) { res.status(500).json({ error: err.message }); }
};

app.post('/api/shop/order/:id/pay', verifyAuth(ROLE_GROUPS.ORDER_APPROVERS), confirmPaymentLogic);
app.put('/api/shop/order/:id/pay', verifyAuth(ROLE_GROUPS.ORDER_APPROVERS), confirmPaymentLogic);

// رفض طلب شراء من شوب الأعضاء
app.post('/api/shop/order/:id/reject', verifyAuth(ROLE_GROUPS.ORDER_APPROVERS), async (req, res) => {
    try {
        const order = await Order.findById(req.params.id);
        if (!order || order.status === 'Paid') return res.status(400).json({ error: "الطلب غير موجود أو تم قبضه مسبقاً." });

        order.status = 'Rejected';
        await order.save();
        io.emit('ordersUpdated');
        res.json({ msg: "تم رفض الطلب." });
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

app.get('/api/admin/users', verifyAuth(ROLE_GROUPS.ADMIN), async (req, res) => {
    try {
        const users = await User.find({}, 'username role duty_status weekly_hours is_blacklisted consecutive_misses');
        res.json(users);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/change-role', verifyAuth(ROLE_GROUPS.ADMIN), async (req, res) => {
    try {
        const { target_username, new_role } = req.body;
        if (new_role === ROLES.DON) return res.status(403).json({ error: "لا يمكن منح رتبة الدون (Don) بهذه الطريقة!" });
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

app.post('/api/admin/reset-password', verifyAuth(ROLE_GROUPS.ADMIN), async (req, res) => {
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

app.post('/api/admin/adjust-hours', verifyAuth(ROLE_GROUPS.ADMIN), async (req, res) => {
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

app.get('/api/admin/audit-log', verifyAuth(ROLE_GROUPS.ADMIN), async (req, res) => {
    try {
        const logs = await AuditLog.find().sort({ timestamp: -1 }).limit(200);
        res.json(logs);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// تصفير ساعات الدوام الأسبوعية (متاح للدون فقط — زر أرشفة الجدول في قسم الحضور)
app.post('/api/admin/reset-weekly-hours', verifyAuth(ROLE_GROUPS.DON_ONLY), async (req, res) => {
    try {
        await User.updateMany({}, { weekly_hours: 0, duty_status: 'OFF-DUTY', total_heists: 0 });
        await WeeklyPurchase.deleteMany({});
        io.emit('dutyUpdated');
        res.json({ msg: "تم تصفير ساعات الدوام الأسبوعية لكل الأعضاء بنجاح." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ================== القائمة السوداء (أداة إدارة مستقلة) ==================
app.post('/api/admin/blacklist/set', verifyAuth(ROLE_GROUPS.ADMIN), async (req, res) => {
    try {
        const { target_username, blacklist } = req.body;
        const user = await User.findOne({ username: target_username });
        if (!user) return res.status(404).json({ error: "العضو غير موجود." });

        user.is_blacklisted = !!blacklist;
        if (user.is_blacklisted) {
            user.duty_status = 'OFF-DUTY';
            forceUserLogout(target_username);
        }
        await user.save();

        await new AuditLog({
            action: blacklist ? 'blacklist_added' : 'blacklist_removed',
            target_username,
            performed_by: req.user.username,
            details: blacklist ? 'إدراج في القائمة السوداء' : 'الإخراج من القائمة السوداء'
        }).save();

        io.emit('dutyUpdated', { username: user.username, duty_status: user.duty_status });
        io.emit('auditLogUpdated');
        res.json({ msg: blacklist ? `تم إدراج "${target_username}" في القائمة السوداء.` : `تم إخراج "${target_username}" من القائمة السوداء.` });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/stats/leaderboard', async (req, res) => {
    try {
        const users = await User.find({ is_blacklisted: false, account_status: 'approved', role: { $ne: ROLES.GANG_MEMBER } }, 'username weekly_hours role duty_status');
        const fmt = users.map(u => ({ username: u.username, role: u.role, duty_status: u.duty_status, hours: u.weekly_hours }));
        
        res.json({ 
            leaderboard: [...fmt].sort((a,b)=> b.hours - a.hours), 
            slacking: fmt.filter(u=> u.hours < 600)
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ================== v8.0: نظام الملاحظات (الأوتوماتيكية) ==================
app.get('/api/notes/my', verifyAuth(ROLE_GROUPS.MEMBERS), async (req, res) => {
    try {
        const notes = await MemberNote.find({ username: req.user.username }).sort({ timestamp: -1 });
        res.json(notes);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/notes/all', verifyAuth(ROLE_GROUPS.DON_AND_ADMIN), async (req, res) => {
    try {
        const notes = await MemberNote.find().sort({ timestamp: -1 });
        res.json(notes);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ================== v8.0: حذف ملاحظة ==================
app.delete('/api/notes/:id', verifyAuth(ROLE_GROUPS.DON_AND_ADMIN), async (req, res) => {
    try {
        const note = await MemberNote.findByIdAndDelete(req.params.id);
        if (!note) return res.status(404).json({ error: "الملاحظة غير موجودة." });
        io.emit('notesUpdated');
        res.json({ msg: "تم حذف الملاحظة بنجاح." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ================== v8.0: سجل الحضور الأسبوعي (مبني على بصمات الدخول/الخروج الفعلية) ==================
// يوم الدوام الواحد يمتد من 22:00 إلى 04:00 بتوقيت الجزائر (ليلة الدوام تُحسب لليوم الذي تبدأ فيه)
app.get('/api/attendance/week', verifyAuth(ROLE_GROUPS.ATTENDANCE_VIEW), async (req, res) => {
    try {
        // تحديد آخر 7 أيام دوام (كل يوم دوام يمتد من 22:00 حتى 04:00 بتوقيت الجزائر)
        const days = buildDutyWeekDays(7);

        const members = await User.find({
            is_blacklisted: false,
            account_status: 'approved',
            role: { $ne: ROLES.GANG_MEMBER }
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
app.post('/api/inventory/add', verifyAuth(ROLE_GROUPS.DON_AND_SHOP), async (req, res) => {
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

app.get('/api/inventory/items', verifyAuth(ROLE_GROUPS.MEMBERS), async (req, res) => {
    try {
        const items = await InventoryItem.find().sort({ timestamp: -1 });
        res.json(items);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/inventory/item/:id', verifyAuth(ROLE_GROUPS.DON_AND_SHOP), async (req, res) => {
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

app.delete('/api/inventory/item/:id', verifyAuth(ROLE_GROUPS.DON_AND_SHOP), async (req, res) => {
    try {
        await InventoryItem.findByIdAndDelete(req.params.id);
        io.emit('inventoryUpdated');
        res.json({ msg: "تم حذف المنتج من المخزون بنجاح." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ================== الموافقة على الحسابات الجديدة (مافيا أو عصابات) — GRH أو الدون ==================
app.get('/api/admin/pending-accounts', verifyAuth(ROLE_GROUPS.ADMIN), async (req, res) => {
    try {
        const pending = await User.find({ account_status: 'pending' }, 'username role gang_name discord_id timestamp');
        res.json(pending);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/pending-accounts/review', verifyAuth(ROLE_GROUPS.ADMIN), async (req, res) => {
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
            details: user.role === ROLES.GANG_MEMBER ? `عضو عصابة: ${user.gang_name}` : 'عضو مافيا'
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

app.post('/api/gang-shop/add-item', verifyAuth(ROLE_GROUPS.SHOP_MANAGER), async (req, res) => {
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

app.put('/api/gang-shop/item/:id', verifyAuth(ROLE_GROUPS.SHOP_MANAGER), async (req, res) => {
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

app.delete('/api/gang-shop/item/:id', verifyAuth(ROLE_GROUPS.SHOP_MANAGER), async (req, res) => {
    try {
        await GangShopItem.findByIdAndDelete(req.params.id);
        io.emit('gangShopUpdated');
        res.json({ msg: "تم حذف المنتج بنجاح." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

const MAX_QTY_PER_LINE = 100000;

app.post('/api/gang-shop/checkout', verifyAuth(ROLE_GROUPS.GANG_MEMBER_ONLY), async (req, res) => {
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

app.get('/api/gang-shop/my-orders', verifyAuth(ROLE_GROUPS.GANG_MEMBER_ONLY), async (req, res) => {
    try {
        const orders = await GangOrder.find({ gang_member_username: req.user.username }).sort({ timestamp: -1 });
        res.json(orders);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// إلغاء/تعديل طلب معلّق من العضو صاحب الطلب نفسه فقط
app.post('/api/gang-shop/order/:id/cancel', verifyAuth(ROLE_GROUPS.GANG_MEMBER_ONLY), async (req, res) => {
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

app.get('/api/gang-shop/orders', verifyAuth(ROLE_GROUPS.ORDER_APPROVERS), async (req, res) => {
    try { const orders = await GangOrder.find().sort({ timestamp: -1 }); res.json(orders); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/gang-shop/order/:id/confirm', verifyAuth(ROLE_GROUPS.ORDER_APPROVERS), async (req, res) => {
    try {
        const order = await GangOrder.findById(req.params.id);
        if (!order || order.status !== 'Pending') return res.status(400).json({ error: "الطلب غير موجود أو لم يعد معلقاً." });

        order.status = 'Confirmed';
        await order.save();

        io.emit('gangOrdersUpdated');
        res.json({ msg: "تم تأكيد الطلب." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/gang-shop/order/:id/reject', verifyAuth(ROLE_GROUPS.ORDER_APPROVERS), async (req, res) => {
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
        if (!user || (user.role !== ROLES.DON && user.role !== ROLES.UNDERBOSS)) return;
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
        } catch (err) { logger.error(err.message); }
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
    } catch (err) { logger.error(err.message); }
}, 300000); 

// ================== الملاحظات التلقائية للغياب — تُرسل يومياً في الساعة 04:00 بتوقيت الجزائر ==================
let lastAutoNoteDate = '';
setInterval(async () => {
    try {
        const dzNow = algeriaNow();
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
            role: { $nin: [ROLES.DON, ROLES.GANG_MEMBER] }
        });

        for (const user of users) {
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
                is_auto: true
            }).save();

            await user.save();
        }

        io.emit('notesUpdated');
        io.emit('dutyUpdated', {});
    } catch (err) { logger.error("Auto-note error: " + err.message); }
}, 60000);

// ================== تنظيف الملاحظات التلقائية القديمة (أقدم من 7 أيام) يومياً عند 22:00 بتوقيت الجزائر ==================
setInterval(async () => {
    try {
        const dzNow = algeriaNow();
        const hours = dzNow.getUTCHours();
        const minutes = dzNow.getUTCMinutes();
        if (hours !== 22 || minutes > 0) return;

        const cutoff = new Date(dzNow.getTime() - 7 * 24 * 60 * 60 * 1000);

        const result = await MemberNote.deleteMany({
            is_auto: true,
            timestamp: { $lt: cutoff }
        });

        if (result.deletedCount > 0) {
            logger.log(`Cleaned ${result.deletedCount} auto notes older than 7 days`);
            io.emit('notesUpdated');
        }
    } catch (err) { logger.error("Auto-note cleanup error: " + err.message); }
}, 60000);

server.listen(PORT, () => logger.log("[CORTEZ] Server v8.0 - Notes & Attendance & Inventory Update running on port " + PORT));
