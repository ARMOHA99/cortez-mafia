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

// الرابط الخاص بقاعدة البيانات
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://moha:cutureire@cluster0.qgk83qz.mongodb.net/cortez?appName=Cluster0';

mongoose.connect(MONGO_URI)
  .then(() => console.log('✓ Connected Strictly to Cortez DB (v7.7 - Fine System Update).'))
  .catch(err => console.error('❌ Database Error:', err));

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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

// ---------------- المخططات (Schemas) ----------------
const UserSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    discord_id: { type: String, required: true },
    role: { type: String, enum: ['Don', 'Business_Manager', 'Chef_Braquage', 'GRH', 'Soldat', 'Gang_Supervisor', 'Gang_Member'], default: 'Soldat' },
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
// map_x و map_y إحداثيات نسبية (0 إلى 100) لموقع العصابة فوق صورة خريطة GTA، وليست بكسل ثابت،
// حتى يبقى الموقع صحيحاً بغض النظر عن حجم الشاشة أو حجم الصورة المعروضة.
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

// ================== تحديث: نظام شوب أعضاء العصابات (منفصل تماماً عن شوب المافيا) ==================
const GangShopItemSchema = new mongoose.Schema({
    name: { type: String, required: true },
    buy_price: { type: Number, required: true },  // السعر اللي يشتريه عضو العصابة من المافيا
    sell_price: { type: Number, required: true }, // السعر اللي تشتريه المافيا من عضو العصابة (يفترض أقل من buy_price)
    image_url: { type: String, default: 'https://placehold.co/150x150/1a1a1a/ffaa00?text=Item' },
    created_by: String,
    timestamp: { type: Date, default: Date.now }
});

const GangOrderSchema = new mongoose.Schema({
    gang_member_username: String,
    gang_name: String,
    items_bought: { type: Array, default: [] }, // [{name, quantity, unit_price, total}]
    items_sold: { type: Array, default: [] },   // [{name, quantity, unit_price, total}]
    total_buy_value: { type: Number, default: 0 },
    total_sell_value: { type: Number, default: 0 },
    net_amount: { type: Number, default: 0 }, // موجب = صافي دخل لخزينة المافيا، سالب = صافي خارج منها
    status: { type: String, enum: ['Pending', 'Confirmed'], default: 'Pending' },
    timestamp: { type: Date, default: Date.now }
});

const GangTreasurySchema = new mongoose.Schema({ total_balance: { type: Number, default: 0 } });

const GangShopItem = mongoose.model('GangShopItem', GangShopItemSchema);
const GangOrder = mongoose.model('GangOrder', GangOrderSchema);
const GangTreasury = mongoose.model('GangTreasury', GangTreasurySchema);

async function initSystemDB() {
    try {
        const treasuryCount = await Treasury.countDocuments({});
        if (treasuryCount === 0) { await new Treasury({ total_balance: 0 }).save(); }

        // تحديث: تهيئة خزينة شوب العصابات المستقلة
        const gangTreasuryCount = await GangTreasury.countDocuments({});
        if (gangTreasuryCount === 0) { await new GangTreasury({ total_balance: 0 }).save(); }
        
        const goalCount = await WeeklyGoal.countDocuments({});
        if (goalCount === 0) { await new WeeklyGoal({ target_amount: 0, payout_percentage: 0, current_progress: 0, is_visible: false }).save(); }
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

// ================== مسارات نظام السرقات والأهداف الأسبوعية ==================

app.post('/api/heist/set-goal', verifyAuth(['Don']), async (req, res) => {
    try {
        const target = Number(req.body.target || 0);
        const percentage = Number(req.body.percentage || 0);
        const activeUsersCount = await User.countDocuments({ is_blacklisted: false, weekly_hours: { $gte: 600 } });
        
        let goal = await WeeklyGoal.findOne();
        if (!goal) { goal = new WeeklyGoal(); } 
        
        goal.target_amount = target;
        goal.payout_percentage = percentage;
        await goal.save();
        
        const payoutPerMember = target * (percentage / 100);
        const totalDeducted = payoutPerMember * activeUsersCount;
        const netProfit = target - totalDeducted;
        
        io.emit('goalUpdated');
        res.json({ 
            msg: "تم تحديث الهدف الأسبوعي بنجاح وتعميمه.", 
            stats: { active_users: activeUsersCount, payout_per_user: payoutPerMember, total_deducted: totalDeducted, net_profit: netProfit } 
        });
    } catch (err) { res.status(500).json({ error: "فشل تحديث الهدف: " + err.message }); }
});

app.post('/api/heist/toggle-goal', verifyAuth(['Don']), async (req, res) => {
    try {
        const { is_visible } = req.body;
        let goal = await WeeklyGoal.findOne();
        if (!goal) { goal = new WeeklyGoal(); }
        
        goal.is_visible = !!is_visible;
        await goal.save();
        
        io.emit('goalUpdated');
        res.json({ msg: `تم ${goal.is_visible ? 'إظهار' : 'إخفاء'} شريط الأهداف بنجاح لجميع الأعضاء.` });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/heist/reset-goal', verifyAuth(['Don']), async (req, res) => {
    try {
        await WeeklyGoal.updateMany({}, { current_progress: 0 });
        io.emit('goalUpdated');
        res.json({ msg: "تم تصفير شريط الأهداف للبدء من جديد." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/heist/types', verifyAuth(['Don']), async (req, res) => {
    try {
        const { action, name } = req.body;
        if (!name) return res.status(400).json({ error: "اسم السرقة مطلوب." });
        
        if (action === 'add') {
            await new HeistType({ name }).save();
            res.json({ msg: "تمت إضافة نوع السرقة الجديد للائحة القيادة." });
        } else if (action === 'delete') {
            await HeistType.deleteOne({ name });
            res.json({ msg: "تم إزالة نوع السرقة من اللائحة." });
        } else { res.status(400).json({ error: "إجراء غير معروف." }); }
    } catch (err) { res.status(500).json({ error: "الاسم مسجل مسبقاً أو حدث خطأ في النظام." }); }
});

app.get('/api/heist/types', async (req, res) => {
    try { const types = await HeistType.find(); res.json(types); } 
    catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/heist/items', verifyAuth(['Business_Manager']), async (req, res) => {
    try {
        const { name, price } = req.body;
        if (!name) return res.status(400).json({ error: "اسم الغنيمة مطلوب." });
        
        let item = await HeistItem.findOne({ name });
        if (item) { item.price = Number(price || 0); } 
        else { item = new HeistItem({ name, price: Number(price || 0) }); }
        
        await item.save();
        res.json({ msg: "تم تسعير الغنيمة وتحديث قيمتها في السوق السوداء للعصابة." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/heist/items', async (req, res) => {
    try { const items = await HeistItem.find(); res.json(items); } 
    catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/heist/submit', verifyAuth(['Chef_Braquage', 'Business_Manager', 'Don']), async (req, res) => {
    try {
        const { heist_type, participants, status, cash, loss, items } = req.body;
        
        let total_value = 0;
        let items_details = [];
        
        if (status === 'Win') {
            total_value += Number(cash || 0);
            if (items && items.length > 0) {
                for (let i of items) {
                    const dbItem = await HeistItem.findOne({ name: i.name });
                    const itemPrice = dbItem ? dbItem.price : 0;
                    const itemQty = Number(i.quantity || 0);
                    const itemTotal = itemPrice * itemQty;
                    total_value += itemTotal;
                    items_details.push({ name: i.name, quantity: itemQty, price: itemPrice, total: itemTotal });
                }
            }
        } else if (status === 'Loss') {
            total_value -= Number(loss || 0); 
        } else { return res.status(400).json({ error: "حالة العملية يجب أن تكون Win أو Loss." }); }
        
        let goal = await WeeklyGoal.findOne();
        if (!goal) { goal = new WeeklyGoal(); }
        goal.current_progress += total_value;
        await goal.save();
        
        if (participants && participants.length > 0) {
            await User.updateMany({ username: { $in: participants } }, { $inc: { total_heists: 1 } });
        }
        
        await new HeistLog({
            chef_name: req.user.username,
            heist_type,
            status,
            participants,
            cash_amount: Number(cash || 0),
            loss_amount: Number(loss || 0),
            items: items_details,
            total_value
        }).save();
        
        io.emit('goalUpdated');
        io.emit('dutyUpdated'); 
        res.json({ msg: "تم تدوين العملية الميدانية بنجاح، وتحديث شريط الأهداف واللوقات." });
    } catch (err) { res.status(500).json({ error: "خطأ في معالجة بيانات العملية: " + err.message }); }
});

app.get('/api/heist/dashboard', verifyAuth(['Don', 'Business_Manager', 'Chef_Braquage', 'GRH', 'Soldat', 'Gang_Supervisor']), async (req, res) => {
    try {
        const goal = await WeeklyGoal.findOne();
        if (!goal || !goal.is_visible) { return res.json({ visible: false }); }
        res.json({ visible: true, target_amount: goal.target_amount, current_progress: goal.current_progress });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/heist/logs', verifyAuth(['GRH', 'Soldat']), async (req, res) => {
    try {
        const logs = await HeistLog.find().sort({ timestamp: -1 });
        res.json(logs);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ================== مسارات النظام الأساسية ==================
app.post('/api/auth/register', async (req, res) => {
    try {
        const { username, password, discord_id } = req.body;
        if (!discord_id) return res.status(400).json({ error: "حقل الـ Discord ID مطلوب." });
        const hashedPassword = await bcrypt.hash(password, 10);
        const isFirstUser = (await User.countDocuments({})) === 0;
        const newUser = new User({ username, password: hashedPassword, discord_id: String(discord_id), role: isFirstUser ? 'Don' : 'Soldat' });
        await newUser.save();
        res.status(201).json({ msg: `تم التسجيل بنجاح.` });
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
        io.emit('gangMemberPending');
        res.status(201).json({ msg: "تم إرسال طلبك بنجاح. يرجى انتظار موافقة قيادة المافيا لتفعيل حسابك." });
    } catch (err) { res.status(400).json({ error: "حدث خطأ أثناء التسجيل، تأكد من اسم المستخدم." }); }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const user = await User.findOne({ username });
        if (!user || !(await bcrypt.compare(password, user.password))) return res.status(400).json({ error: "خطأ في اسم المستخدم أو كلمة المرور." });
        if (user.is_blacklisted) return res.status(403).json({ error: "تم حظرك ومطاردتك من عائلة كورتيز (بلاك ليست)." });

        // تحديث: عضو العصابة لازم يكون حسابه "approved" من GRH أو الدون قبل ما يقدر يدخل
        if (user.role === 'Gang_Member') {
            if (user.account_status === 'pending') return res.status(403).json({ error: "حسابك لسا بانتظار موافقة قيادة المافيا. حاول لاحقاً." });
            if (user.account_status === 'rejected') return res.status(403).json({ error: "تم رفض طلب انضمامك لهذا النظام." });
        }
        
        // جلب معلومات التوكن مع الغرامات المضافة حديثاً
        const token = jwt.sign({ id: user._id, role: user.role, username: user.username }, JWT_SECRET, { expiresIn: '24h' });
        res.json({ token, user: { username: user.username, role: user.role, gang_name: user.gang_name, duty_status: user.duty_status, fine_amount: user.fine_amount, fine_reason: user.fine_reason } });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// تحديث لتزويد الفرونت إند ببيانات الغرامة الحالية فوراً عند طلب الملف الشخصي
app.get('/api/auth/me', async (req, res) => {
    try {
        const token = req.headers['authorization']?.split(' ')[1];
        if (!token) return res.status(401).json({ error: "غير مصرح" });
        const decoded = jwt.verify(token, JWT_SECRET);
        const user = await User.findById(decoded.id, 'username role duty_status fine_amount fine_reason');
        res.json(user);
    } catch { res.status(401).json({ error: "جلسة منتهية" }); }
});

app.get('/api/users/list', verifyAuth(['Chef_Braquage', 'Business_Manager', 'Don']), async (req, res) => {
    try {
        const users = await User.find({ is_blacklisted: false }, 'username');
        res.json(users);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/shop/items', async (req, res) => {
    try { const items = await Item.find().sort({ timestamp: -1 }); res.json(items); } 
    catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/shop/add-item', verifyAuth(['Business_Manager']), async (req, res) => {
    try {
        const { name, price, image_url } = req.body;
        const newItem = new Item({ name, price: Number(price), image_url, created_by: req.user.username });
        await newItem.save();
        io.emit('shopUpdated');
        res.status(201).json({ msg: "تم إضافة الآيتم بنجاح إلى الشوب الرئاسي." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/shop/item/:id', verifyAuth(['Business_Manager']), async (req, res) => {
    try {
        const { price } = req.body;
        await Item.findByIdAndUpdate(req.params.id, { price: Number(price) });
        io.emit('shopUpdated');
        res.json({ msg: "تم تعديل السعر بنجاح." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/shop/item/:id', verifyAuth(['Business_Manager']), async (req, res) => {
    try {
        await Item.findByIdAndDelete(req.params.id);
        io.emit('shopUpdated');
        res.json({ msg: "تم حذف المنتج بنجاح." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/shop/checkout', verifyAuth(['Soldat', 'GRH', 'Chef_Braquage', 'Business_Manager', 'Gang_Supervisor']), async (req, res) => {
    try {
        const { items } = req.body;
        if (!items || items.length === 0) return res.status(400).json({ error: "السلة فارغة." });
        
        let total_price = 0;
        const processedItems = items.map(i => {
            const qty = i.quantity ? parseInt(i.quantity) : 1;
            const itemTotal = Number(i.price) * qty;
            total_price += itemTotal;
            return { name: i.name, price: Number(i.price), quantity: qty, total: itemTotal };
        });

        const newOrder = new Order({ username: req.user.username, items: processedItems, total_price: total_price, status: 'Pending' });
        await newOrder.save();
        io.emit('ordersUpdated');
        res.json({ msg: "تم رفع طلبك للإدارة بنجاح، يرجى تسليم المبلغ داخل المدينة." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/shop/orders', verifyAuth(['Business_Manager', 'Chef_Braquage', 'GRH']), async (req, res) => {
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

app.post('/api/shop/order/:id/pay', verifyAuth(['Business_Manager']), confirmPaymentLogic);
app.put('/api/shop/order/:id/pay', verifyAuth(['Business_Manager']), confirmPaymentLogic);

app.get('/api/treasury/balance', verifyAuth(['Business_Manager']), async (req, res) => {
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

app.get('/api/admin/users', verifyAuth(['GRH']), async (req, res) => {
    try {
        const users = await User.find({}, 'username role duty_status weekly_hours warnings is_blacklisted fine_amount fine_reason');
        res.json(users);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/change-role', verifyAuth(['GRH']), async (req, res) => {
    try {
        const { target_username, new_role } = req.body;
        if (new_role === 'Don') return res.status(403).json({ error: "لا يمكن منح رتبة البوس (Don) لأي شخص!" });
        await User.findOneAndUpdate({ username: target_username }, { role: new_role });
        io.emit('dutyUpdated', {}); res.json({ msg: `تم تحديث الرتبة بنجاح.` });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/reset-weekly-hours', verifyAuth(['Don']), async (req, res) => {
    try {
        const currentUsers = await User.find({ is_blacklisted: false }, 'username role weekly_hours');
        await new Archive({ records: currentUsers }).save();
        
        await User.updateMany({}, { weekly_hours: 0, duty_status: 'OFF-DUTY', total_heists: 0 }); 
        await WeeklyGoal.updateMany({}, { current_progress: 0 }); 
        
        io.emit('dutyUpdated'); io.emit('goalUpdated');
        res.json({ msg: "تمت أرشفة الأسبوع بنجاح وتصفير الساعات والسرقات والهدف الأسبوعي لبدء دورة جديدة." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/archive', verifyAuth(['GRH']), async (req, res) => {
    try { const archives = await Archive.find().sort({ week_date: -1 }); res.json(archives); } 
    catch (err) { res.status(500).json({ error: err.message }); }
});

// ================== تحديث v7.7: نظام العقوبات المطور والغرامات المالية ==================
app.post('/api/admin/penalty', verifyAuth(['GRH']), async (req, res) => {
    try {
        const { target_username, type, reason, fine_amount } = req.body;
        const user = await User.findOne({ username: target_username });
        if (!user) return res.status(404).json({ error: "المستخدم غير موجود." });

        let penaltyAmount = 0;

        if (type === 'Warning') {
            // تحديث: نسجل تاريخ كل إنذار على حدة بدل زيادة رقم فقط، حتى يُحذف تلقائياً بعد شهر (راجع cleanupExpiredWarnings)
            user.warning_dates.push(new Date());
            user.warnings = user.warning_dates.length;
            if (user.warnings >= 3) user.is_blacklisted = true;
        } else if (type === 'Blacklist') {
            user.is_blacklisted = true; user.duty_status = 'OFF-DUTY';
        } else if (type === 'Remove_Blacklist') {
            user.is_blacklisted = false; user.warnings = 0; user.warning_dates = [];
        } else if (type === 'Fine') {
            // إضافة الغرامة المالية الجديدة للعضو
            penaltyAmount = Number(fine_amount || 0);
            if (penaltyAmount <= 0) return res.status(400).json({ error: "يرجى تحديد مبلغ الغرامة بشكل صحيح." });
            user.fine_amount += penaltyAmount;
            user.fine_reason = reason || "مخالفة القوانين الداخلية";
        }
        
        await user.save();
        await new PenaltyLog({ target_username, admin_username: req.user.username, type, reason, fine_amount: penaltyAmount }).save();
        
        // إطلاق تحديث فوري عبر السوكيت ليتأثر حساب العضو فوراً بالواجهة
        io.emit('dutyUpdated', { username: user.username, duty_status: user.duty_status });
        io.emit('finesUpdated');
        
        res.json({ msg: "تم تطبيق الإجراء الإداري وتدوينه بنجاح." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// جلب قائمة الأشخاص الذين عليهم غرامات فقط (لجدول الإدارة)
app.get('/api/admin/fines/active', verifyAuth(['GRH']), async (req, res) => {
    try {
        const finedUsers = await User.find({ fine_amount: { $gt: 0 } }, 'username role fine_amount fine_reason');
        res.json(finedUsers);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// زر الإدارة: تأكيد تسلّم ودفع الغرامة يدوياً وتحويلها تلقائياً للخزينة
app.post('/api/admin/fines/pay', verifyAuth(['GRH']), async (req, res) => {
    try {
        const { target_username } = req.body;
        const user = await User.findOne({ username: target_username });
        if (!user || user.fine_amount <= 0) return res.status(400).json({ error: "المستخدم ليس لديه أي غرامة معلقة." });

        const amountPaid = user.fine_amount;
        
        // تصفير غرامة العضو
        user.fine_amount = 0;
        user.fine_reason = "";
        await user.save();

        // تحويل الأموال تلقائياً إلى الخزينة
        await Treasury.updateOne({}, { $inc: { total_balance: amountPaid } });

        io.emit('finesUpdated');
        io.emit('treasuryUpdated');
        io.emit('dutyUpdated'); // لتحديث التنبيه عند الفرد فوراً
        
        res.json({ msg: `تم تسوية الغرامة بنجاح، وتحويل مبلغ ${amountPaid}$ مباشرة إلى خزينة العصابة.` });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/stats/leaderboard', async (req, res) => {
    try {
        const users = await User.find({ is_blacklisted: false }, 'username weekly_hours role duty_status total_heists');
        const fmt = users.map(u => ({ username: u.username, role: u.role, duty_status: u.duty_status, hours: u.weekly_hours, heists: u.total_heists }));
        
        res.json({ 
            leaderboard: [...fmt].sort((a,b)=> b.hours - a.hours), 
            slacking: fmt.filter(u=> u.hours < 600),
            heists_leaderboard: [...fmt].sort((a,b)=> b.heists - a.heists) 
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/hr/leave', verifyAuth(['Soldat', 'GRH', 'Chef_Braquage', 'Business_Manager', 'Gang_Supervisor']), async (req, res) => {
    try {
        await new Leave({ username: req.user.username, reason: req.body.reason, duration: Number(req.body.duration) }).save();
        io.emit('requestUpdated'); res.json({ msg: "تم رفع طلب الإجازة بنجاح." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/hr/justify', verifyAuth(['Soldat', 'GRH', 'Chef_Braquage', 'Business_Manager', 'Gang_Supervisor']), async (req, res) => {
    try {
        await new Justification({ username: req.user.username, reason: req.body.reason }).save();
        io.emit('requestUpdated'); res.json({ msg: "تم رفع تبرير الغياب بنجاح." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/hr/requests', verifyAuth(['GRH']), async (req, res) => {
    try {
        const leaves = await Leave.find({ status: 'Pending' });
        const justifications = await Justification.find({ status: 'Pending' });
        res.json({ leaves, justifications });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/hr/action', verifyAuth(['GRH']), async (req, res) => {
    try {
        const { type, id, action } = req.body;
        if (type === 'leave') await Leave.findByIdAndUpdate(id, { status: action });
        if (type === 'justify') await Justification.findByIdAndUpdate(id, { status: action });
        io.emit('requestUpdated'); res.json({ msg: "تم تحديث حالة الطلب والبت فيه." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ================== تحديث: نظام تتبع العصابات (Gang Tracking) ==================
// القراءة مفتوحة لكل الأعضاء (نفس منطق /api/shop/items)، والتعديل حصراً على Gang_Supervisor (والـ Don تلقائياً عبر verifyAuth)
app.get('/api/gangs', async (req, res) => {
    try {
        const gangs = await Gang.find().sort({ name: 1 });
        res.json(gangs);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/gangs', verifyAuth(['Gang_Supervisor']), async (req, res) => {
    try {
        const { name, radio_frequency, loyalty_percentage, notes, map_x, map_y } = req.body;
        if (!name) return res.status(400).json({ error: "اسم العصابة مطلوب." });
        if (map_x === undefined || map_y === undefined) return res.status(400).json({ error: "يرجى تحديد موقع العصابة على الخريطة." });

        const newGang = new Gang({
            name,
            radio_frequency: radio_frequency || '',
            loyalty_percentage: Number(loyalty_percentage ?? 50),
            notes: notes || '',
            map_x: Number(map_x),
            map_y: Number(map_y),
            created_by: req.user.username,
            updated_by: req.user.username
        });
        await newGang.save();
        io.emit('gangsUpdated');
        res.status(201).json({ msg: "تمت إضافة العصابة بنجاح إلى نظام التتبع." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/gangs/:id', verifyAuth(['Gang_Supervisor']), async (req, res) => {
    try {
        const { name, radio_frequency, loyalty_percentage, notes, map_x, map_y } = req.body;
        const gang = await Gang.findById(req.params.id);
        if (!gang) return res.status(404).json({ error: "العصابة غير موجودة." });

        if (name) gang.name = name;
        if (radio_frequency !== undefined) gang.radio_frequency = radio_frequency;
        if (loyalty_percentage !== undefined) gang.loyalty_percentage = Number(loyalty_percentage);
        if (notes !== undefined) gang.notes = notes;
        if (map_x !== undefined) gang.map_x = Number(map_x);
        if (map_y !== undefined) gang.map_y = Number(map_y);
        gang.updated_by = req.user.username;
        gang.updated_at = new Date();

        await gang.save();
        io.emit('gangsUpdated');
        res.json({ msg: "تم تعديل بيانات العصابة بنجاح." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/gangs/:id', verifyAuth(['Gang_Supervisor']), async (req, res) => {
    try {
        const deleted = await Gang.findByIdAndDelete(req.params.id);
        if (!deleted) return res.status(404).json({ error: "العصابة غير موجودة أو محذوفة مسبقاً." });
        io.emit('gangsUpdated');
        res.json({ msg: "تم حذف العصابة من نظام التتبع بنجاح." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ================== تحديث: الموافقة على تسجيل أعضاء العصابات (GRH أو الدون) ==================
app.get('/api/admin/gang-members/pending', verifyAuth(['GRH']), async (req, res) => {
    try {
        const pending = await User.find({ role: 'Gang_Member', account_status: 'pending' }, 'username gang_name discord_id timestamp');
        res.json(pending);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/gang-members/review', verifyAuth(['GRH']), async (req, res) => {
    try {
        const { target_username, decision } = req.body;
        if (!['approve', 'reject'].includes(decision)) return res.status(400).json({ error: "قرار غير صالح." });

        const user = await User.findOne({ username: target_username, role: 'Gang_Member' });
        if (!user) return res.status(404).json({ error: "الحساب غير موجود." });

        user.account_status = decision === 'approve' ? 'approved' : 'rejected';
        await user.save();
        io.emit('gangMemberPending');
        res.json({ msg: decision === 'approve' ? `تم تفعيل حساب ${target_username} بنجاح.` : `تم رفض طلب ${target_username}.` });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ================== تحديث: شوب أعضاء العصابات (منفصل كلياً عن شوب المافيا) ==================
// القراءة مفتوحة (نفس منطق شوب المافيا)؛ الإدارة حصراً على Business_Manager
app.get('/api/gang-shop/items', async (req, res) => {
    try { const items = await GangShopItem.find().sort({ timestamp: -1 }); res.json(items); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/gang-shop/add-item', verifyAuth(['Business_Manager']), async (req, res) => {
    try {
        const { name, buy_price, sell_price, image_url } = req.body;
        if (!name || buy_price === undefined || sell_price === undefined) return res.status(400).json({ error: "الاسم وسعر الشراء وسعر البيع كلها مطلوبة." });
        const newItem = new GangShopItem({ name, buy_price: Number(buy_price), sell_price: Number(sell_price), image_url, created_by: req.user.username });
        await newItem.save();
        io.emit('gangShopUpdated');
        res.status(201).json({ msg: "تمت إضافة المنتج إلى شوب العصابات بنجاح." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/gang-shop/item/:id', verifyAuth(['Business_Manager']), async (req, res) => {
    try {
        const { name, buy_price, sell_price, image_url } = req.body;
        const update = {};
        if (name !== undefined) update.name = name;
        if (buy_price !== undefined) update.buy_price = Number(buy_price);
        if (sell_price !== undefined) update.sell_price = Number(sell_price);
        if (image_url !== undefined) update.image_url = image_url;
        await GangShopItem.findByIdAndUpdate(req.params.id, update);
        io.emit('gangShopUpdated');
        res.json({ msg: "تم تعديل المنتج بنجاح." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/gang-shop/item/:id', verifyAuth(['Business_Manager']), async (req, res) => {
    try {
        await GangShopItem.findByIdAndDelete(req.params.id);
        io.emit('gangShopUpdated');
        res.json({ msg: "تم حذف المنتج بنجاح." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// تنفيذ عملية شراء/بيع/مقايضة من طرف عضو العصابة — الأسعار تُحسب من قاعدة البيانات حصراً (أمان، ما نثق بأي سعر قادم من العميل)
app.post('/api/gang-shop/checkout', verifyAuth(['Gang_Member']), async (req, res) => {
    try {
        const { items_bought, items_sold } = req.body;
        if ((!items_bought || items_bought.length === 0) && (!items_sold || items_sold.length === 0)) {
            return res.status(400).json({ error: "لم يتم تحديد أي منتج للشراء أو البيع." });
        }

        const catalog = await GangShopItem.find();
        const findItem = (name) => catalog.find(c => c.name === name);

        let total_buy_value = 0;
        const processedBought = (items_bought || []).map(i => {
            const catalogItem = findItem(i.name);
            if (!catalogItem) throw new Error(`المنتج "${i.name}" غير موجود بالكتالوج.`);
            const qty = Math.max(1, parseInt(i.quantity) || 1);
            const total = catalogItem.buy_price * qty;
            total_buy_value += total;
            return { name: i.name, quantity: qty, unit_price: catalogItem.buy_price, total };
        });

        let total_sell_value = 0;
        const processedSold = (items_sold || []).map(i => {
            const catalogItem = findItem(i.name);
            if (!catalogItem) throw new Error(`المنتج "${i.name}" غير موجود بالكتالوج.`);
            const qty = Math.max(1, parseInt(i.quantity) || 1);
            const total = catalogItem.sell_price * qty;
            total_sell_value += total;
            return { name: i.name, quantity: qty, unit_price: catalogItem.sell_price, total };
        });

        const net_amount = total_buy_value - total_sell_value;
        const user = await User.findOne({ username: req.user.username });

        const newOrder = new GangOrder({
            gang_member_username: req.user.username,
            gang_name: user ? user.gang_name : '',
            items_bought: processedBought, items_sold: processedSold,
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

app.get('/api/gang-shop/orders', verifyAuth(['Business_Manager']), async (req, res) => {
    try { const orders = await GangOrder.find().sort({ timestamp: -1 }); res.json(orders); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/gang-shop/order/:id/confirm', verifyAuth(['Business_Manager']), async (req, res) => {
    try {
        const order = await GangOrder.findById(req.params.id);
        if (!order || order.status === 'Confirmed') return res.status(400).json({ error: "الطلب غير صحيح أو مؤكد مسبقاً." });

        order.status = 'Confirmed';
        await order.save();
        await GangTreasury.updateOne({}, { $inc: { total_balance: order.net_amount } });

        io.emit('gangOrdersUpdated'); io.emit('gangTreasuryUpdated');
        res.json({ msg: "تم تأكيد إتمام العملية وتحديث خزينة شوب العصابات." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/gang-shop/treasury', verifyAuth(['Business_Manager']), async (req, res) => {
    try {
        const treasury = await GangTreasury.findOne({});
        const balance = treasury ? treasury.total_balance : 0;
        res.json({ balance_raw: balance, balance_formatted: formatMoneyShort(balance) });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// تصفير خزينة شوب العصابات حصراً على الدون، بنفس منطق تصفير الخزينة الرئيسية
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
                user.duty_status = 'ON-DUTY'; user.last_punch_in = now;
            } else {
                if (user.last_punch_in) user.weekly_hours += Math.floor((now - user.last_punch_in) / 60000);
                user.duty_status = 'OFF-DUTY';
            }
            await user.save();
            io.emit('dutyUpdated', { username: user.username, duty_status: user.duty_status });
            socket.emit('statusResponse', { username: user.username, duty_status: user.duty_status });
        } catch (err) { console.error(err.message); }
    });
});

setInterval(async () => {
    try {
        const activeUsers = await User.find({ duty_status: 'ON-DUTY' });
        const maxTimeMs = 8 * 60 * 60 * 1000; 
        const now = new Date();
        let stateChanged = false;

        for (let u of activeUsers) {
            if (u.last_punch_in && (now - u.last_punch_in > maxTimeMs)) {
                u.weekly_hours += Math.floor(maxTimeMs / 60000);
                u.duty_status = 'OFF-DUTY';
                await u.save();
                stateChanged = true;
            }
        }
        if (stateChanged) io.emit('dutyUpdated', {});
    } catch (err) { console.error(err.message); }
}, 300000); 

// ================== تحديث: حذف الإنذارات (Warnings) تلقائياً بعد مرور شهر عليها ==================
// ملاحظة: هذا يُحدّث فقط عدّاد warnings الحي (المستخدم لحساب البلاك ليست التلقائي)، ولا يمس
// سجل PenaltyLog الذي يبقى أرشيفاً تاريخياً دائماً لكل الإجراءات، ولا يزيل البلاك ليست تلقائياً
// إذا كان قد تم تفعيله مسبقاً (إزالته تبقى إجراء يدوي عبر Remove_Blacklist).
const WARNING_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000; // شهر واحد (30 يوم)

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
        io.emit('dutyUpdated', {}); // لتحديث جدول الإدارة فوراً عند أي تغيير بالعدادات
    } catch (err) { console.error("خطأ في تنظيف الإنذارات المنتهية:", err.message); }
}

setInterval(cleanupExpiredWarnings, 3600000); // فحص كل ساعة
cleanupExpiredWarnings(); // تشغيل فوري أيضاً عند إقلاع السيرفر

server.listen(PORT, () => console.log(`📡 Cortez System v7.7 running safely on port ${PORT}`));
