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

mongoose.connect(MONGO_URI).then(() => console.log('✓ Connected to Cortez DB (Advanced ERP Mode).')).catch(err => console.error(err));

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ----------------- المخططات (Schemas) -----------------
const UserSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    discord_id: { type: String, required: true },
    role: { type: String, enum: ['Don', 'Business_Manager', 'Chef_Braquage', 'HR_Manager', 'Soldier'], default: 'Soldier' },
    duty_status: { type: String, enum: ['ON-DUTY', 'OFF-DUTY'], default: 'OFF-DUTY' },
    is_blacklisted: { type: Boolean, default: false }
});

const ItemSchema = new mongoose.Schema({
    name: { type: String, required: true },
    price: { type: Number, required: true },
    image_url: { type: String, default: 'https://placehold.co/150x150/0d0d0d/00ff66?text=Item' },
    in_stock: { type: Boolean, default: true },
    created_by: String,
    timestamp: { type: Date, default: Date.now }
});

const OrderSchema = new mongoose.Schema({
    username: String,
    items: Array,
    total_price: Number,
    status: { type: String, enum: ['Pending', 'Paid'], default: 'Pending' },
    timestamp: { type: Date, default: Date.now }
});

const TreasurySchema = new mongoose.Schema({ total_balance: { type: Number, default: 0 } });
const LeaveSchema = new mongoose.Schema({ username: String, reason: String, duration: Number, status: { type: String, default: 'Pending' }});
const JustificationSchema = new mongoose.Schema({ username: String, reason: String, status: { type: String, default: 'Pending' }});

const User = mongoose.model('User', UserSchema);
const Item = mongoose.model('Item', ItemSchema);
const Order = mongoose.model('Order', OrderSchema);
const Treasury = mongoose.model('Treasury', TreasurySchema);
const Leave = mongoose.model('Leave', LeaveSchema);
const Justification = mongoose.model('Justification', JustificationSchema);

async function initTreasury() { const count = await Treasury.countDocuments({}); if (count === 0) await new Treasury({ total_balance: 0 }).save(); } initTreasury();

const verifyAuth = (roles) => {
    return (req, res, next) => {
        const token = req.headers['authorization']?.split(' ')[1];
        if (!token) return res.status(401).json({ error: "غير مصرح." });
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            const hasAccess = roles.includes(decoded.role) || decoded.role === 'Don';
            if (!hasAccess) return res.status(403).json({ error: "رتبتك لا تسمح بالدخول." });
            req.user = decoded; next();
        } catch { res.status(400).json({ error: "توكن غير صالح." }); }
    }
};

// ----------------- الدخول -----------------
app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    const user = await User.findOne({ username });
    if (!user || !(await bcrypt.compare(password, user.password))) return res.status(400).json({ error: "خطأ في البيانات." });
    if (user.is_blacklisted) return res.status(403).json({ error: "تم حظرك." });
    const token = jwt.sign({ id: user._id, role: user.role, username: user.username }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ token, user: { username: user.username, role: user.role, duty_status: user.duty_status } });
});

// ----------------- المتجر والمخزون -----------------
app.get('/api/shop/items', async (req, res) => { res.json(await Item.find().sort({ timestamp: -1 })); });

app.post('/api/shop/add-item', verifyAuth(['Business_Manager', 'Chef_Braquage']), async (req, res) => {
    const { name, price, image_url } = req.body;
    await new Item({ name, price, image_url, created_by: req.user.username }).save();
    io.emit('shopUpdated'); res.json({ msg: "تمت إضافة المنتج." });
});

app.put('/api/shop/edit-item/:id', verifyAuth(['Business_Manager', 'Chef_Braquage']), async (req, res) => {
    const { name, price, image_url } = req.body;
    await Item.findByIdAndUpdate(req.params.id, { name, price, image_url });
    io.emit('shopUpdated'); res.json({ msg: "تم تعديل المنتج." });
});

app.put('/api/shop/toggle-stock/:id', verifyAuth(['Business_Manager', 'Chef_Braquage']), async (req, res) => {
    const item = await Item.findById(req.params.id);
    item.in_stock = !item.in_stock; await item.save();
    io.emit('shopUpdated'); res.json({ msg: "تم تحديث حالة المخزون." });
});

app.delete('/api/shop/delete-item/:id', verifyAuth(['Business_Manager', 'Chef_Braquage']), async (req, res) => {
    await Item.findByIdAndDelete(req.params.id);
    io.emit('shopUpdated'); res.json({ msg: "تم حذف المنتج." });
});

// ----------------- الطلبات والسلة -----------------
app.post('/api/shop/checkout', verifyAuth(['Soldier', 'HR_Manager', 'Chef_Braquage', 'Business_Manager']), async (req, res) => {
    const { cart } = req.body;
    if(!cart || cart.length === 0) return res.status(400).json({error: "السلة فارغة"});
    
    let total_price = 0; let orderItems = [];
    for(let cartItem of cart) {
        const item = await Item.findById(cartItem.item_id);
        if(item && item.in_stock) {
            total_price += (item.price * cartItem.quantity);
            orderItems.push({ item_name: item.name, quantity: cartItem.quantity, price: item.price });
        }
    }
    const newOrder = new Order({ username: req.user.username, items: orderItems, total_price, status: 'Pending' });
    await newOrder.save();
    io.emit('ordersUpdated');
    res.json({ msg: "تم تأكيد الطلب.", order_id: newOrder._id, total_price, items: orderItems });
});

app.get('/api/shop/orders', verifyAuth(['Business_Manager', 'Chef_Braquage']), async (req, res) => { res.json(await Order.find().sort({ timestamp: -1 })); });

app.post('/api/shop/confirm-payment', verifyAuth(['Business_Manager', 'Chef_Braquage']), async (req, res) => {
    const order = await Order.findById(req.body.order_id);
    if (!order || order.status === 'Paid') return res.status(400).json({ error: "الطلب مدفوع أو غير صالح." });
    order.status = 'Paid'; await order.save();
    await Treasury.updateOne({}, { $inc: { total_balance: order.total_price } });
    io.emit('ordersUpdated'); io.emit('treasuryUpdated'); res.json({ msg: "تم تأكيد الدفع." });
});

app.delete('/api/shop/delete-order/:id', verifyAuth(['Don']), async (req, res) => {
    await Order.findByIdAndDelete(req.params.id);
    io.emit('ordersUpdated'); res.json({ msg: "تم مسح السجل بأمر الدون." });
});

// ----------------- الخزينة -----------------
app.get('/api/treasury/balance', verifyAuth(['Business_Manager', 'Chef_Braquage']), async (req, res) => {
    const treasury = await Treasury.findOne({}); res.json({ balance: treasury ? treasury.total_balance : 0 });
});

app.post('/api/treasury/reset', verifyAuth(['Don', 'Business_Manager', 'Chef_Braquage']), async (req, res) => {
    await Treasury.updateOne({}, { total_balance: 0 });
    io.emit('treasuryUpdated'); res.json({ msg: "تم تصفير الخزينة." });
});

// ----------------- الإجازات والغيابات (HR) -----------------
app.post('/api/hr/justification', verifyAuth(['Soldier', 'HR_Manager', 'Chef_Braquage', 'Business_Manager', 'Don']), async (req, res) => {
    const { reason } = req.body;
    if (!reason) return res.status(400).json({ error: "يجب كتابة السبب." });
    await new Justification({ username: req.user.username, reason, status: 'Pending' }).save();
    res.json({ msg: "تم إرسال العذر للإدارة بنجاح." });
});

app.post('/api/hr/leave', verifyAuth(['Soldier', 'HR_Manager', 'Chef_Braquage', 'Business_Manager', 'Don']), async (req, res) => {
    const { reason, duration } = req.body;
    if (!reason || !duration) return res.status(400).json({ error: "يجب تحديد السبب والمدة." });
    await new Leave({ username: req.user.username, reason, duration, status: 'Pending' }).save();
    res.json({ msg: "تم رفع طلب الإجازة للمراجعة." });
});

server.listen(PORT, () => console.log(`📡 Cortez System v6.5 running on port ${PORT}`));
