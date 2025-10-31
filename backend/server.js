import express from "express";
import Razorpay from "razorpay";
import bodyParser from "body-parser";
import cors from "cors";
import mongoose from "mongoose";
import nodemailer from "nodemailer";
import crypto from "crypto";
import dotenv from "dotenv";
dotenv.config();

const app = express();

// CORS configuration
app.use(cors({
  origin: ["https://herbsayurmed.com", "http://127.0.0.1:5500", "http://localhost:5500"],
  methods: ["GET", "POST"],
  credentials: true,
}));
app.use(bodyParser.json());

// Connect to MongoDB
mongoose.connect(process.env.MONGO_URI)
.then(() => {
  console.log("✅ MongoDB connected successfully");

  const PORT = process.env.PORT || 5000;
  app.listen(PORT, () => {
    console.log(`✅ Backend running on http://localhost:${PORT}`);
    console.log(`✅ Razorpay Key ID: ${process.env.RAZORPAY_KEY_ID ? 'Configured' : 'Missing'}`);
    console.log(`✅ MongoDB URI: ${process.env.MONGO_URI ? 'Configured' : 'Missing'}`);
  });
})
.catch(err => {
  console.error("❌ Failed to connect to MongoDB:", err.message);
  process.exit(1);
});


// Order Schema
const orderSchema = new mongoose.Schema({
  orderId: String,
  customer: {
    name: String,
    phone: String,
    email: String,
    address: String,
    city: String,
    state: String,
    pincode: String
  },
  items: Array,
  subtotal: Number,
  shipping: Number,
  total: Number,
  paymentMethod: String, // "online" or "cod"
  paymentStatus: String, // "paid" or "pending"
  payment: Object,
  createdAt: { type: Date, default: Date.now }
});

const Order = mongoose.model("Order", orderSchema);

// Razorpay setup
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

// Create Razorpay order
app.post("/create-order", async (req, res) => {
  try {
    const { amount, currency } = req.body;
    
    console.log("Creating order for amount:", amount);
    
    const options = {
      amount: amount * 100, // amount in paise
      currency: currency || "INR",
      receipt: "order_rcptid_" + Date.now()
    };
    
    const order = await razorpay.orders.create(options);
    console.log("✅ Razorpay order created:", order.id);
    
    res.json(order);
  } catch (err) {
    console.error("❌ Error creating order:", err);
    res.status(500).json({ error: "Failed to create order", details: err.message });
  }
});
// Get Razorpay key for frontend
app.get("/get-razorpay-key", (req, res) => {
  res.json({ key: process.env.RAZORPAY_KEY_ID });
});

// Save order after payment
app.post("/save-order", async (req, res) => {
  try {
    const { orderData, payment } = req.body;
    
    console.log("Received order data:", {
      customer: orderData.customer.name,
      total: orderData.total,
      paymentMethod: payment ? "online" : "cod"
    });

    const orderId = "HSM" + Date.now();
    
    // Prepare order object
    const orderToSave = {
      orderId: orderId,
      customer: orderData.customer,
      items: orderData.items,
      subtotal: orderData.subtotal,
      shipping: orderData.shipping,
      total: orderData.total,
      paymentMethod: payment ? "online" : "cod",
      paymentStatus: payment ? "paid" : "pending",
      payment: payment || null
    };

    // ✅ Only verify signature for ONLINE payments
    if (payment && payment.razorpay_signature) {
      const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = payment;

      const sign = razorpay_order_id + "|" + razorpay_payment_id;
      const expectedSign = crypto
        .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
        .update(sign.toString())
        .digest("hex");

      if (razorpay_signature !== expectedSign) {
        console.error("❌ Payment verification failed");
        return res.status(400).json({ error: "Invalid payment signature" });
      }
      
      console.log("✅ Payment signature verified");
    }

    // Save to MongoDB
    const newOrder = new Order(orderToSave);
    await newOrder.save();
    console.log("✅ Order saved to database:", newOrder._id);

    // Send email notification
    try {
      await sendOrderEmail(newOrder);
      console.log("✅ Email sent successfully");
    } catch (emailErr) {
      console.error("⚠️ Email failed (but order saved):", emailErr.message);
      // Don't fail the request if email fails
    }

    res.json({ 
      success: true, 
      orderId: orderId,
      message: "Order placed successfully" 
    });

  } catch (err) {
    console.error("❌ Error saving order:", err);
    res.status(500).json({ 
      error: "Failed to save order", 
      details: err.message 
    });
  }
});

// Send order email
async function sendOrderEmail(order) {
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.EMAIL_USER || "yourbusiness@gmail.com",
      pass: process.env.EMAIL_PASS || "pgia ioxf iode tweg"
    }
  });

  const itemsList = order.items.map(
    item => `${item.name} (x${item.qty}) - ₹${item.price * item.qty}`
  ).join("\n");

  const mailOptions = {
    from: `Herbsayurmed <${process.env.EMAIL_USER || "yourbusiness@gmail.com"}>`,
    to: process.env.EMAIL_USER || "yourbusiness@gmail.com",
    subject: `🛍️ New Order ${order.orderId} from ${order.customer.name}`,
    text: `
New Order Received!

📋 Order ID: ${order.orderId}
💳 Payment: ${order.paymentMethod === "online" ? "PAID ✅" : "COD (Pending)"}

👤 Customer: ${order.customer.name}
📞 Phone: ${order.customer.phone}
📧 Email: ${order.customer.email}
🏠 Address: ${order.customer.address}, ${order.customer.city}, ${order.customer.state} - ${order.customer.pincode}

📦 Items:
${itemsList}

💰 Subtotal: ₹${order.subtotal}
🚚 Shipping: ₹${order.shipping}
💵 Total: ₹${order.total}
-----------------------------------
🕒 Date: ${new Date(order.createdAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}
    `,
    html: `
    <div style="font-family: Arial; max-width: 600px; border: 2px solid #22c55e; border-radius: 10px; padding: 20px;">
      <h1 style="color: #22c55e;">🛍️ New Order Received!</h1>
      
      <div style="background: #f0fdf4; padding: 15px; border-radius: 8px; margin: 15px 0;">
        <h2>Order #${order.orderId}</h2>
        <p><strong>Payment:</strong> <span style="color: ${order.paymentMethod === 'online' ? '#22c55e' : '#f59e0b'};">${order.paymentMethod === 'online' ? 'PAID ✅' : 'COD (Pending)'}</span></p>
      </div>

      <div style="background: #fff7ed; padding: 15px; border-radius: 8px; margin: 15px 0;">
        <h3>Customer Details:</h3>
        <p><strong>${order.customer.name}</strong><br>
        📞 ${order.customer.phone}<br>
        📧 ${order.customer.email}</p>
      </div>

      <div style="background: #fef3c7; padding: 15px; border-radius: 8px; margin: 15px 0;">
        <h3>Delivery Address:</h3>
        <p>${order.customer.address}<br>
        ${order.customer.city}, ${order.customer.state} - ${order.customer.pincode}</p>
      </div>

      <div style="background: #eff6ff; padding: 15px; border-radius: 8px; margin: 15px 0;">
        <h3>Items to Pack:</h3>
        <ul>
          ${order.items.map(item => `<li><strong>${item.qty}x ${item.name}</strong> - ₹${item.price * item.qty}</li>`).join('')}
        </ul>
      </div>

      <div style="background: #f3f4f6; padding: 15px; border-radius: 8px; text-align: center;">
        <h2>Total: ₹${order.total}</h2>
        <p style="font-size: 12px;">Subtotal: ₹${order.subtotal} | Shipping: ₹${order.shipping}</p>
      </div>

      <p style="text-align: center; color: #6b7280; margin-top: 20px;">
        Order placed on ${new Date(order.createdAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}
      </p>
    </div>
    `
  };

  await transporter.sendMail(mailOptions);
}

// Health check endpoint
app.get("/", (req, res) => {
  res.json({ 
    status: "Server is running", 
    timestamp: new Date().toISOString() 
  });
});
