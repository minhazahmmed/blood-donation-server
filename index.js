require("dotenv").config(); 
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const stripe = require("stripe")(process.env.STRIPE_SECRET);

const port = process.env.PORT || 5000;
const app = express();

//  Middleware 
app.use(cors());
app.use(express.json());

// Firebase Admin Setup
const decoded = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString(
  "utf8"
);
const serviceAccount = JSON.parse(decoded);

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

// Middleware: Verify Firebase Token
const verifyFBToken = async (req, res, next) => {
  const token = req.headers.authorization;
  if (!token) return res.status(401).send({ message: "unauthorized access" });

  try {
    const idToken = token.split(" ")[1];
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    req.decoded_email = decodedToken.email;
    next();
  } catch (error) {
    return res.status(401).send({ message: "unauthorized access" });
  }
};

// MongoDB Connection Setup
const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

// Collections Definition 
const database = client.db("BloodDonationAppDB");
const userCollections = database.collection("user");
const requestsCollection = database.collection("request");
const paymentsCollection = database.collection("payments");
const blogCollection = database.collection("blogs");

// Step-1: await commands কমেন্ট করা হয়েছে
// async function run() {
//     try {
//         await client.connect();
//         console.log("Connected to MongoDB");
//     } catch (error) {
//         console.error(error);
//     }
// }
// run().catch(console.dir);

// --- ROUTES (সবগুলো run ফাংশনের বাইরে নিয়ে আসা হয়েছে) ---

app.get("/", (req, res) => res.send("Blood Donation Server is Running"));

// --- User APIs ---
app.get("/user/:email", verifyFBToken, async (req, res) => {
  const email = req.params.email;
  const result = await userCollections.findOne({ email });
  if (!result) return res.status(404).send({ message: "User not found" });
  res.send(result);
});

app.post("/users", async (req, res) => {
  try {
    const userInfo = req.body;
    const query = { email: userInfo.email };
    const existingUser = await userCollections.findOne(query);

    if (existingUser) {
      return res.send({ message: "User exists", insertedId: null });
    }

   
    const newUser = {
      name: userInfo.name,
      email: userInfo.email,
      photoURL: userInfo.photoURL || userInfo.image, 
      blood: userInfo.blood || "", 
      district: userInfo.district || "",
      upazila: userInfo.upazila || "",
      role: "donor",
      status: "active",
      createdAt: new Date()
    };

    const result = await userCollections.insertOne(newUser);
    res.send(result);
  } catch (error) {
    res.status(500).send({ error: "Failed to sync user" });
  }
});
app.get("/users", verifyFBToken, async (req, res) => {
  const result = await userCollections.find().toArray();
  res.status(200).send(result);
});

app.get("/users/role/:email", async (req, res) => {
  const { email } = req.params;
  const result = await userCollections.findOne({ email });
  res.send(result);
});

app.patch("/update/user/status", verifyFBToken, async (req, res) => {
  const { email, status } = req.query;
  if (email === req.decoded_email)
    return res.status(403).send({ message: "Forbidden: self-action" });
  const result = await userCollections.updateOne(
    { email },
    { $set: { status } }
  );
  res.send(result);
});

app.patch("/update/user/role", verifyFBToken, async (req, res) => {
  const { email, role } = req.query;
  if (email === req.decoded_email)
    return res.status(403).send({ message: "Forbidden: self-action" });
  const result = await userCollections.updateOne({ email }, { $set: { role } });
  res.send(result);
});

app.patch("/user/update/:email", verifyFBToken, async (req, res) => {
  const email = req.params.email;
  if (email !== req.decoded_email)
    return res.status(403).send({ message: "Forbidden access" });
  const updateDoc = { $set: { ...req.body } };
  try {
    const result = await userCollections.updateOne({ email }, updateDoc);
    res.send(result);
  } catch (error) {
    res.status(500).send({ message: "Update failed" });
  }
});

app.get("/admin-stats", verifyFBToken, async (req, res) => {
  try {
    const totalUsers = await userCollections.countDocuments();
    const totalRequests = await requestsCollection.countDocuments();
    const fundingResult = await paymentsCollection
      .aggregate([{ $group: { _id: null, total: { $sum: "$amount" } } }])
      .toArray();
    const totalFunding = fundingResult.length > 0 ? fundingResult[0].total : 0;
    res.send({ totalUsers, totalRequests, totalFunding });
  } catch (error) {
    res.status(500).send({ message: "Failed stats" });
  }
});

// --- Donation Request APIs ---
app.get("/all-requests", verifyFBToken, async (req, res) => {
  const { status, page, size } = req.query;
  const pageNumber = parseInt(page) || 0;
  const limitNumber = parseInt(size) || 10;
  let query = {};
  if (status && status !== "all") query.donation_status = status;
  const result = await requestsCollection
    .find(query)
    .sort({ createdAt: -1 })
    .skip(pageNumber * limitNumber)
    .limit(limitNumber)
    .toArray();
  const totalCount = await requestsCollection.countDocuments(query);
  res.send({ requests: result, totalCount });
});

app.get("/all-pending-requests", async (req, res) => {
 
  const result = await requestsCollection
    .find({ donation_status: "pending" })
    .sort({ createdAt: -1 })
    .toArray();
  res.send(result);
});

// --- GET: Single Donation Request Details ---
app.get("/request/:id", verifyFBToken, async (req, res) => {
  try {
    const id = req.params.id;
    const query = { _id: new ObjectId(id) };
    const result = await requestsCollection.findOne(query);

    if (!result) {
      return res.status(404).send({ message: "Request not found" });
    }

    res.send(result);
  } catch (error) {
    res.status(400).send({ message: "Invalid ID format" });
  }
});

app.post("/requests", verifyFBToken, async (req, res) => {
  const data = req.body;
  data.createdAt = new Date();
  const result = await requestsCollection.insertOne(data);
  res.send(result);
});

//Update Donation Request
// --- PATCH: Update Donation Request Info ---
app.patch("/request/update/:id", verifyFBToken, async (req, res) => {
  try {
    const id = req.params.id;
    const updatedData = req.body;
    const query = { _id: new ObjectId(id) };

    const updateDoc = {
      $set: {
        recipientName: updatedData.recipientName,
        recipient_district: updatedData.recipient_district,
        recipient_upazila: updatedData.recipient_upazila,
        hospitalName: updatedData.hospitalName,
        fullAddress: updatedData.fullAddress,
        bloodGroup: updatedData.bloodGroup,
        donationDate: updatedData.donationDate,
        donationTime: updatedData.donationTime,
        requestMessage: updatedData.requestMessage,
      },
    };

    const result = await requestsCollection.updateOne(query, updateDoc);

    if (result.matchedCount === 0) {
      return res.status(404).send({ message: "Request not found" });
    }

    res.send(result);
  } catch (error) {
    console.error(error);
    res.status(500).send({ message: "Internal server error" });
  }
});

app.get("/search-donors", async (req, res) => {
  const { bloodGroup, district, upazila } = req.query;
  const query = { role: "donor", status: "active" };
  if (bloodGroup && bloodGroup !== "undefined") query.blood = bloodGroup;
  if (district) query.district = district;
  if (upazila) query.upazila = upazila;
  const result = await userCollections.find(query).toArray();
  res.send(result);
});

app.get("/my-request", verifyFBToken, async (req, res) => {
  const email = req.decoded_email;
  const size = parseInt(req.query.size) || 10;
  const page = parseInt(req.query.page) || 0;
  const query = { requester_email: email };
  const result = await requestsCollection
    .find(query)
    .skip(page * size)
    .limit(size)
    .toArray();
  const totalRequest = await requestsCollection.countDocuments(query);
  res.send({ request: result, totalRequest });
});

// --- Stripe Payment APIs ---
app.post("/create-payment-checkout", async (req, res) => {
  const info = req.body;
  const amount = parseInt(info.donateAmount) * 100;
  const origin = req.headers.origin;
  try {
    const session = await stripe.checkout.sessions.create({
      line_items: [
        {
          price_data: {
            currency: "usd",
            unit_amount: amount,
            product_data: { name: "Blood Donation Support" },
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      metadata: { donorName: info?.donorName },
      customer_email: info?.donorEmail,
      success_url: `${origin}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/payment-cancelled`,
    });
    res.send({ url: session.url });
  } catch (error) {
    res.status(500).send({ message: "Stripe error" });
  }
});

app.post("/success-payment", async (req, res) => {
  try {
    const { session_id } = req.query;
    if (!session_id) return res.status(400).send({ message: "No session ID" });
    const session = await stripe.checkout.sessions.retrieve(session_id);
    const transactionId = session.payment_intent;
    const isExist = await paymentsCollection.findOne({ transactionId });
    if (isExist)
      return res.send({ message: "Already recorded", transactionId });
    if (session.payment_status === "paid") {
      const paymentInfo = {
        amount: session.amount_total / 100,
        donorEmail: session.customer_email,
        donorName: session.metadata?.donorName || "Anonymous",
        transactionId,
        paidAt: new Date(),
      };
      const result = await paymentsCollection.insertOne(paymentInfo);
      return res.send(result);
    }
    res.status(400).send({ message: "Payment status not paid" });
  } catch (err) {
    res.status(500).send({ message: "Payment error" });
  }
});

// --- Content Management (Blog) APIs ---
app.post("/blogs", verifyFBToken, async (req, res) => {
  const blog = req.body;
  blog.createdAt = new Date();
  blog.status = "draft";
  const result = await blogCollection.insertOne(blog);
  res.send(result);
});

app.get("/all-blogs", async (req, res) => {
  const { status } = req.query;
  let query = {};
  if (status) query.status = status;
  const result = await blogCollection
    .find(query)
    .sort({ createdAt: -1 })
    .toArray();
  res.send(result);
});

app.patch("/blogs/status/:id", verifyFBToken, async (req, res) => {
  const result = await blogCollection.updateOne(
    { _id: new ObjectId(req.params.id) },
    { $set: { status: req.body.status } }
  );
  res.send(result);
});

app.delete("/blogs/:id", verifyFBToken, async (req, res) => {
  const result = await blogCollection.deleteOne({
    _id: new ObjectId(req.params.id),
  });
  res.send(result);
});

// --- Volunteer Stats API ---
app.get("/volunteer-stats", verifyFBToken, async (req, res) => {
  try {
    const totalRequests = await requestsCollection.countDocuments();
    const pendingRequests = await requestsCollection.countDocuments({
      donation_status: "pending",
    });
    const doneRequests = await requestsCollection.countDocuments({
      donation_status: "done",
    });
    const myDraftBlogs = await blogCollection.countDocuments({
      authorEmail: req.decoded_email,
      status: "draft",
    });
    res.send({ totalRequests, pendingRequests, doneRequests, myDraftBlogs });
  } catch (error) {
    res.status(500).send({ message: "Failed to fetch volunteer stats" });
  }
});

app.patch("/request/status/:id", verifyFBToken, async (req, res) => {
  const result = await requestsCollection.updateOne(
    { _id: new ObjectId(req.params.id) },
    { $set: { donation_status: req.body.status } }
  );
  res.send(result);
});

app.delete("/request/delete/:id", verifyFBToken, async (req, res) => {
  const result = await requestsCollection.deleteOne({
    _id: new ObjectId(req.params.id),
  });
  res.send(result);
});

app.patch("/requests/donate/:id", async (req, res) => {
  const { donorName, donorEmail, status } = req.body;
  const result = await requestsCollection.updateOne(
    { _id: new ObjectId(req.params.id) },
    {
      $set: {
        donor_name: donorName,
        donor_email: donorEmail,
        donation_status: status,
      },
    }
  );
  res.send(result);
});

app.get("/my-requests-recent", verifyFBToken, async (req, res) => {
  const result = await requestsCollection
    .find({ requester_email: req.decoded_email })
    .sort({ createdAt: -1 })
    .limit(3)
    .toArray();
  res.send(result);
});

// Server listen
if (process.env.NODE_ENV !== "production") {
  app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
  });
}

module.exports = app;
