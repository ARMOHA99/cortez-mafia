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

// الرابط الخاص بقاعدة البيانات (يفضل مستقبلاً وضعه في ملف .env)
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://moha:cutureire@cluster0.qgk83qz.mongodb.net/cortez?appName=Cluster0';

mongoose.connect(MONGO_URI)
  .then(() => console.log('✓ Connected Strictly to Cortez DB (v6.2 - Precision Formatting Update).'))
  .catch(err => console.error('❌ Database Error:', err));

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------------- دوال التنسيق المالي (محدثة) ----------------

// دالة تنسيق المبالغ المالية (K للآلاف و M للملايين) - مخصصة للخزينة
const formatMoneyShort = (amount) => {
    if (!amount) return '0';
    if (amount >= 1000000) return (amount / 1000000).toFixed(2).replace(/\.00$/, '') + 'M';
    if (amount >= 1000) return (amount / 1000).toFixed(2).replace(/\.00$/, '') + 'K';
    return amount.toString();
};

// دالة الفواتير والسلة (تعرض الرقم بدقة مع فواصل الآلاف)
const formatMoneyExact = (amount) => {
    if (!amount) return '0';
    return amount.toLocaleString('en-US');
};

// ---------------- المخططات (Schemas) ----------------
const UserSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    discord_id: { type: String, required: true },
    role: { type: String, enum: ['Don', 'Business_Manager', 'Chef_Braquage', 'HR_Manager', 'Soldier'], default: 'Soldier' },
    duty_status: { type: String, enum: ['ON-DUTY', 'OFF-DUTY'], default: 'OFF-DUTY' },
    last_punch_in: { type: Date },
    weekly_hours: { type: Number, default: 0 },
    warnings: { type: Number, default: 0 },
    is_blacklisted: { type: Boolean, default: false }
});

const LeaveSchema = new mongoose.Schema({ username: String, reason: String, duration: Number, status: { type: String, default: 'Pending' }, timestamp: { type: Date, default: Date.now } });
const JustificationSchema = new mongoose.Schema({ username: String, reason: String, status: { type: String, default: 'Pending' }, timestamp: { type: Date, default: Date.now } });
const PenaltyLogSchema = new mongoose.Schema({ target_username: String, admin_username: String, type: String, reason: String, timestamp: { type: Date, default: Date.now } });

const ArchiveSchema = new mongoose.Schema({ 
    week_date: { type: Date, default: Date.now }, 
    records: Array 
});

const ItemSchema = new mongoose.Schema({
    name: { type: String, required: true },
    price: { type: Number, required: true },
    image_url: { type: String, default: 'https://placehold.co/150x150/0d0d0d/00ff66?text=Item' },
    created_by: String,
    timestamp: { type: Date, default: Date.now }
});

// مخطط الطلبات محدث لدعم الكميات
const OrderSchema = new mongoose.Schema({
    username: String,
    item_name: String, 
    price: Number,      
    items: Array, // ستشمل الآن: { name, price, quantity, total }
    total_price: Number, 
    status: { type: String, enum: ['Pending', 'Paid'], default: 'Pending' },
    timestamp: { type: Date, default: Date.now }
});

const TreasurySchema = new mongoose.Schema({
    total_balance: { type: Number, default: 0 }
});

const User = mongoose.model('User', UserSchema);
const Leave = mongoose.model('Leave', LeaveSchema);
const Justification = mongoose.model('Justification', JustificationSchema);
const PenaltyLog = mongoose.model('PenaltyLog', PenaltyLogSchema);
const Archive = mongoose.model('Archive', ArchiveSchema);
const Item = mongoose.model('Item', ItemSchema);
const Order = mongoose.model('Order', OrderSchema);
const Treasury = mongoose.model('Treasury', TreasurySchema);

async function initTreasury() {
    const count = await Treasury.countDocuments({});
    if (count === 0) { await new Treasury({ total_balance: 0 }).save(); }
}
initTreasury();

// ---------------- نظام الصلاحيات ----------------
const verifyAuth = (roles) => {
    return (req, res, next) => {
        const token = req.headers['authorization']?.split(' ')[1];
        if (!token) return res.status(401).json({ error: "غير مصرح." });
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            // الدون له صلاحيات مطلقة، الـ HR يقدر يسوي شغل البزنس
            const hasAccess = roles.includes(decoded.role) || decoded.role === 'Don' || (roles.includes('HR_Manager') && decoded.role === 'Business_Manager');
            if (!hasAccess) return res.status(403).json({ error: "رتبتك لا تسمح بالدخول." });
            req.user = decoded; next();
        } catch { res.status(400).json({ error: "توكن غير صالح." }); }
    }
};

// مسارات التسجيل والدخول
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

// ---------------- مسارات الشوب والخزينة ----------------
app.get('/api/shop/items', async (req, res) => {
    const items = await Item.find().sort({ timestamp: -1 });
    res.json(items);
});

// الشيف براكاج لديه تحكم كامل في منتجات الشوب
app.post('/api/shop/add-item', verifyAuth(['Business_Manager', 'Chef_Braquage']), async (req, res) => {
    const { name, price, image_url } = req.body;
    const newItem = new Item({ name, price, image_url, created_by: req.user.username });
    await newItem.save();
    io.emit('shopUpdated');
    res.status(201).json({ msg: "تم إضافة الآيتم بنجاح إلى الشوب الرئاسي." });
});

app.put('/api/shop/item/:id', verifyAuth(['Business_Manager', 'Chef_Braquage']), async (req, res) => {
    const { price } = req.body;
    await Item.findByIdAndUpdate(req.params.id, { price });
    io.emit('shopUpdated');
    res.json({ msg: "تم تعديل السعر بنجاح." });
});

app.delete('/api/shop/item/:id', verifyAuth(['Business_Manager', 'Chef_Braquage']), async (req, res) => {
    await Item.findByIdAndDelete(req.params.id);
    io.emit('shopUpdated');
    res.json({ msg: "تم حذف المنتج بنجاح." });
});

// رفع الطلب مع دعم نظام الكميات للجميع
app.post('/api/shop/checkout', verifyAuth(['Soldier', 'HR_Manager', 'Chef_Braquage', 'Business_Manager']), async (req, res) => {
    const { items } = req.body;
    if (!items || items.length === 0) return res.status(400).json({ error: "السلة فارغة." });
    
    let total_price = 0;
    const processedItems = items.map(i => {
        const qty = i.quantity ? parseInt(i.quantity) : 1; // إذا لم يحدد، نعتبرها 1
        const itemTotal = i.price * qty;
        total_price += itemTotal;
        return { name: i.name, price: i.price, quantity: qty, total: itemTotal };
    });

    const newOrder = new Order({ 
        username: req.user.username, 
        items: processedItems, 
        total_price: total_price, 
        status: 'Pending' 
    });
    
    await newOrder.save();
    io.emit('ordersUpdated');
    res.json({ msg: "تم رفع طلبك للإدارة بنجاح، يرجى تسليم المبلغ داخل المدينة." });
});

// رؤية الطلبات وتأكيد الدفع (للشيف براكاج ومدراء الأعمال)
app.get('/api/shop/orders', verifyAuth(['Business_Manager', 'Chef_Braquage', 'HR_Manager']), async (req, res) => {
    const orders = await Order.find().sort({ timestamp: -1 });
    res.json(orders);
});

app.post('/api/shop/confirm-payment', verifyAuth(['Business_Manager', 'Chef_Braquage']), async (req, res) => {
    const { order_id } = req.body;
    const order = await Order.findById(order_id);
    if (!order || order.status === 'Paid') return res.status(400).json({ error: "الطلب غير صحيح أو مدفوع مسبقاً." });
    
    order.status = 'Paid';
    await order.save();
    
    const amountToAdd = order.total_price || order.price; 
    await Treasury.updateOne({}, { $inc: { total_balance: amountToAdd } });
    
    io.emit('ordersUpdated');
    io.emit('treasuryUpdated');
    res.json({ msg: "تم تأكيد الدفع وإضافة المبلغ إلى الخزينة العليا للعصابة." });
});

app.get('/api/treasury/balance', verifyAuth(['Business_Manager', 'Chef_Braquage', 'HR_Manager']), async (req, res) => {
    const treasury = await Treasury.findOne({});
    // تم استخدام الدالة المختصرة formatMoneyShort هنا للخزينة
    res.json({ 
        balance_raw: treasury ? treasury.total_balance : 0,
        balance_formatted: formatMoneyShort(treasury ? treasury.total_balance : 0)
    });
});

app.post('/api/treasury/reset', verifyAuth(['Don']), async (req, res) => {
    await Treasury.updateOne({}, { total_balance: 0 });
    io.emit('treasuryUpdated');
    res.json({ msg: "تم تصفير الخزينة بالكامل بناءً على أوامر القيادة العليا." });
});

// نظام الـ BON (متاح لجميع الأعضاء) + مع دعم الكميات و الدقة المالية
app.get('/api/shop/invoice/:id', async (req, res) => {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).send("الطلب غير موجود");
    
    let itemsList = '';
    if (order.items && order.items.length > 0) {
        itemsList = order.items.map(i => {
            const qty = i.quantity || 1;
            const itemTotal = i.price * qty;
            // تم استخدام الدالة الدقيقة formatMoneyExact هنا للفاتورة
            return `<li>${qty}x ${i.name} - ${formatMoneyExact(itemTotal)}$</li>`;
        }).join('');
    } else {
        itemsList = `<li>1x ${order.item_name} - ${formatMoneyExact(order.price)}$</li>`;
    }

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
});

// ---------------- مسارات الإدارة والأرشيف ----------------
// الشيف براكاج لم يعد هنا (HR والبزنس فقط)
app.get('/api/admin/users', verifyAuth(['HR_Manager', 'Business_Manager']), async (req, res) => {
    const users = await User.find({}, 'username role duty_status weekly_hours warnings is_blacklisted');
    res.json(users);
});

app.post('/api/admin/change-role', verifyAuth(['Business_Manager']), async (req, res) => {
    const { target_username, new_role } = req.body;
    await User.findOneAndUpdate({ username: target_username }, { role: new_role });
    io.emit('dutyUpdated', {}); res.json({ msg: `تم تحديث الرتبة.` });
});

app.post('/api/admin/reset-weekly-hours', verifyAuth(['Don']), async (req, res) => {
    const currentUsers = await User.find({ is_blacklisted: false }, 'username role weekly_hours');
    await new Archive({ records: currentUsers }).save();
    await User.updateMany({}, { weekly_hours: 0, duty_status: 'OFF-DUTY' });
    io.emit('dutyUpdated', {}); 
    res.json({ msg: "تمت أرشفة الأسبوع بنجاح وتصفير الساعات لجميع الأفراد." });
});

app.get('/api/admin/archive', verifyAuth(['HR_Manager', 'Business_Manager']), async (req, res) => {
    const archives = await Archive.find().sort({ week_date: -1 });
    res.json(archives);
});

app.post('/api/admin/penalty', verifyAuth(['HR_Manager', 'Business_Manager']), async (req, res) => {
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
    res.json({ msg: "تم تطبيق الإجراء." });
});

// ---------------- مسارات الإحصائيات والـ HR ----------------
app.get('/api/stats/leaderboard', async (req, res) => {
    const users = await User.find({ is_blacklisted: false }, 'username weekly_hours role duty_status');
    const fmt = users.map(u => ({ username: u.username, role: u.role, duty_status: u.duty_status, hours: u.weekly_hours }));
    res.json({ leaderboard: [...fmt].sort((a,b)=> b.hours - a.hours), slacking: fmt.filter(u=> u.hours < 600) });
});

app.post('/api/hr/leave', verifyAuth(['Soldier', 'HR_Manager', 'Chef_Braquage', 'Business_Manager']), async (req, res) => {
    await new Leave({ username: req.user.username, reason: req.body.reason, duration: req.body.duration }).save();
    io.emit('requestUpdated'); res.json({ msg: "تم رفع طلب الإجازة بنجاح." });
});

app.post('/api/hr/justify', verifyAuth(['Soldier', 'HR_Manager', 'Chef_Braquage', 'Business_Manager']), async (req, res) => {
    await new Justification({ username: req.user.username, reason: req.body.reason }).save();
    io.emit('requestUpdated'); res.json({ msg: "تم رفع تبرير الغياب بنجاح." });
});

app.get('/api/hr/requests', verifyAuth(['HR_Manager', 'Business_Manager']), async (req, res) => {
    const leaves = await Leave.find({ status: 'Pending' });
    const justifications = await Justification.find({ status: 'Pending' });
    res.json({ leaves, justifications });
});

app.post('/api/hr/action', verifyAuth(['HR_Manager', 'Business_Manager']), async (req, res) => {
    const { type, id, action } = req.body;
    if (type === 'leave') await Leave.findByIdAndUpdate(id, { status: action });
    if (type === 'justify') await Justification.findByIdAndUpdate(id, { status: action });
    io.emit('requestUpdated'); res.json({ msg: "تم تحديث حالة الطلب." });
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

setInterval(async () => {
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
}, 300000); 

server.listen(PORT, () => console.log(`📡 Cortez System v6.2 running on port ${PORT}`));
