const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const express = require("express");
const cors = require("cors");
require("dotenv").config();

const stripe = require("stripe")(process.env.STRIPE_SECRET);
const admin = require("firebase-admin");

const app = express();
const port = process.env.PORT || 5000;

/* =======================
   Middleware
======================= */
app.use(cors({
  origin: [
    "http://localhost:5173",
    "https://blood-donation-project-mongodb.web.app",
    "https://blood-donation-project-mongodb.firebaseapp.com"
  ],
  credentials: true
}));
app.use(express.json());

/* =======================
   Firebase Admin Init (Safe)
======================= */
if (!admin.apps.length && process.env.FB_SERVICE_KEY) {
  const decoded = Buffer.from(
    process.env.FB_SERVICE_KEY,
    "base64"
  ).toString("utf8");

  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(decoded)),
  });
}

/* =======================
   Firebase Token Verify
======================= */
const verifyFBToken = async (req, res, next) => {
  const token = req.headers.authorization;
  if (!token || !token.startsWith("Bearer ")) {
    return res.status(401).send({ message: "unauthorized access" });
  }
  try {
    const decoded = await admin.auth().verifyIdToken(token.split(" ")[1]);
    req.decoded_email = decoded.email;
    next();
  } catch (err) {
    return res.status(401).send({ message: "unauthorized access" });
  }
};

/* =======================
   MongoDB Global Connection (Vercel Safe)
======================= */
let cachedClient = null;

async function connectDB() {
  if (cachedClient) return cachedClient;

  const client = new MongoClient(process.env.MONGODB_URI, {
    serverApi: {
      version: ServerApiVersion.v1,
      strict: true,
      deprecationErrors: true,
    },
  });

  cachedClient = await client.connect();
  console.log("MongoDB connected");
  return cachedClient;
}

/* =======================
   Collections Helper
======================= */
async function getCollections() {
  const client = await connectDB();
  const db = client.db("BloodDonationAppDB");
  return {
    userCollections: db.collection("user"),
    requestsCollection: db.collection("request"),
    paymentsCollection: db.collection("payments"),
    blogCollection: db.collection("blogs"),
  };
}

/* =======================
   Test & Root
======================= */
app.get("/", (req, res) => {
  res.send("Blood Donation Server is Running");
});

app.get("/test", (req, res) => {
  res.send({ message: "Server is online!" });
});

/* =======================
   User APIs
======================= */
app.get("/user/:email", verifyFBToken, async (req, res) => {
  const { userCollections } = await getCollections();
  const result = await userCollections.findOne({ email: req.params.email });
  res.send(result);
});

app.post("/users", async (req, res) => {
  const { userCollections } = await getCollections();
  const user = {
    ...req.body,
    createdAt: new Date(),
    role: "donor",
    status: "active",
  };
  res.send(await userCollections.insertOne(user));
});

app.get("/users", verifyFBToken, async (req, res) => {
  const { userCollections } = await getCollections();
  res.send(await userCollections.find().toArray());
});

app.get("/users/role/:email", async (req, res) => {
  const { userCollections } = await getCollections();
  res.send(await userCollections.findOne({ email: req.params.email }));
});

/* =======================
   Donation Request APIs
======================= */
app.post("/requests", verifyFBToken, async (req, res) => {
  const { requestsCollection } = await getCollections();
  req.body.createdAt = new Date();
  res.send(await requestsCollection.insertOne(req.body));
});

app.get("/all-requests", verifyFBToken, async (req, res) => {
  const { requestsCollection } = await getCollections();
  const result = await requestsCollection.find().sort({ createdAt: -1 }).toArray();
  res.send(result);
});

app.get("/request/:id", async (req, res) => {
  const { requestsCollection } = await getCollections();
  res.send(await requestsCollection.findOne({ _id: new ObjectId(req.params.id) }));
});

app.patch("/request/update/:id", verifyFBToken, async (req, res) => {
  const { requestsCollection } = await getCollections();
  res.send(await requestsCollection.updateOne(
    { _id: new ObjectId(req.params.id) },
    { $set: req.body }
  ));
});

/* =======================
   Blog APIs (UNCHANGED PATHS)
======================= */
app.post("/blogs", verifyFBToken, async (req, res) => {
  const { blogCollection } = await getCollections();
  res.send(await blogCollection.insertOne({
    ...req.body,
    status: "draft",
    createdAt: new Date(),
  }));
});

app.get("/all-blogs", async (req, res) => {
  const { blogCollection } = await getCollections();
  const query = req.query.status ? { status: req.query.status } : {};
  const blogs = await blogCollection.find(query).sort({ createdAt: -1 }).toArray();
  res.send(blogs);
});

app.patch("/blogs/status/:id", verifyFBToken, async (req, res) => {
  const { blogCollection } = await getCollections();
  res.send(await blogCollection.updateOne(
    { _id: new ObjectId(req.params.id) },
    { $set: { status: req.body.status } }
  ));
});

app.delete("/blogs/:id", verifyFBToken, async (req, res) => {
  const { blogCollection } = await getCollections();
  res.send(await blogCollection.deleteOne({ _id: new ObjectId(req.params.id) }));
});

/* =======================
   Stripe
======================= */
app.post("/create-payment-checkout", async (req, res) => {
  const amount = parseInt(req.body.donateAmount) * 100;
  const origin = req.headers.origin;

  const session = await stripe.checkout.sessions.create({
    line_items: [{
      price_data: {
        currency: "usd",
        unit_amount: amount,
        product_data: { name: "Blood Donation Support" },
      },
      quantity: 1,
    }],
    mode: "payment",
    success_url: `${origin}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/payment-cancelled`,
  });

  res.send({ url: session.url });
});

/* =======================
   Localhost Only
======================= */
if (process.env.NODE_ENV !== "production") {
  app.listen(port, () => {
    console.log(`Server running on port ${port}`);
  });
}

module.exports = app;
