const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const express = require("express");
const cors = require("cors");
require("dotenv").config();

const port = process.env.PORT || 5000;
const stripe = require('stripe')(process.env.STRIPE_SECRET);

const app = express();

// CORS configuration
app.use(cors({
  origin: [
    "http://localhost:5173", 
    "https://blood-donation-project-mongodb.web.app", 
    "https://blood-donation-project-mongodb.firebaseapp.com"
  ],
  credentials: true
}));

app.use(express.json());

// Firebase Admin Setup
const admin = require("firebase-admin");
const decoded = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString("utf8");
const serviceAccount = JSON.parse(decoded);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// Middleware: Verify Firebase Token
const verifyFBToken = async (req, res, next) => {
  const token = req.headers.authorization;
  if (!token) return res.status(401).send({ message: "unauthorize access" });

  try {
    const idToken = token.split(" ")[1];
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    req.decoded_email = decodedToken.email;
    next();
  } catch (error) {
    return res.status(401).send({ message: "unauthorize access" });
  }
};

const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    const database = client.db("BloodDonationAppDB");
    const userCollections = database.collection("user");
    const requestsCollection = database.collection("request");
    const paymentsCollection = database.collection('payments');

    // --- User APIs ---

    app.get("/user/:email", verifyFBToken, async (req, res) => {
      const email = req.params.email;
      const query = { email: email };
      const result = await userCollections.findOne(query);
      if (!result) {
        return res.status(404).send({ message: "User not found" });
      }
      res.send(result);
    });

    app.post("/users", async (req, res) => {
      try {
        const userInfo = req.body;
        userInfo.createdAt = new Date();
        userInfo.role = "donor";
        userInfo.status = "active";
        const result = await userCollections.insertOne(userInfo);
        res.send(result);
      } catch (error) {
        res.status(500).send({ error: "Failed to add user" });
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
      const requesterEmail = req.decoded_email;
      if (email === requesterEmail) {
        return res.status(403).send({ message: "Access Denied: You cannot block yourself!" });
      }
      const result = await userCollections.updateOne({ email }, { $set: { status } });
      res.send(result);
    });

    app.patch("/update/user/role", verifyFBToken, async (req, res) => {
      const { email, role } = req.query;
      const requesterEmail = req.decoded_email;
      if (email === requesterEmail) {
        return res.status(403).send({ message: "Access Denied: You cannot change your own role!" });
      }
      const result = await userCollections.updateOne({ email }, { $set: { role } });
      res.send(result);
    });

    app.get("/admin-stats", verifyFBToken, async (req, res) => {
      try {
        const totalUsers = await userCollections.countDocuments();
        const totalRequests = await requestsCollection.countDocuments();
        const fundingResult = await paymentsCollection.aggregate([
            { $group: { _id: null, total: { $sum: "$amount" } } }
        ]).toArray();
        const totalFunding = fundingResult.length > 0 ? fundingResult[0].total : 0;
        res.send({ totalUsers, totalRequests, totalFunding });
      } catch (error) {
        res.status(500).send({ message: "Failed to fetch statistics" });
      }
    });

    app.patch("/user/update/:email", verifyFBToken, async (req, res) => {
      const email = req.params.email;
      const updatedData = req.body;
      const query = { email: email };
      const updatedDoc = {
        $set: {
          name: updatedData.name,
          photoURL: updatedData.photoURL,
          blood: updatedData.blood,
          district: updatedData.district,
          upazila: updatedData.upazila
        }
      };
      const result = await userCollections.updateOne(query, updatedDoc);
      res.send(result);
    });

    // --- Donation Request APIs ---
    app.post("/requests", verifyFBToken, async (req, res) => {
      const data = req.body;
      data.createdAt = new Date();
      const result = await requestsCollection.insertOne(data);
      res.send(result);
    });


    app.get('/search-donors', async (req, res) => {
    try {
        const { bloodGroup, district, upazila } = req.query;
        
        // ডিফল্টভাবে শুধু একটিভ ডোনারদের খুঁজবে
        const query = { 
            role: "donor", 
            status: "active" 
        };

        // ড্রপডাউন থেকে আসা ব্লাড গ্রুপ (A+, B+ ইত্যাদি) হ্যান্ডেল করা
        if (bloodGroup && bloodGroup !== "undefined") {
            query.blood = bloodGroup; 
        }
        
        if (district && district !== "") {
            query.district = district;
        }
        
        if (upazila && upazila !== "") {
            query.upazila = upazila;
        }

        const result = await userCollections.find(query).toArray();
        res.send(result);
    } catch (error) {
        res.status(500).send({ message: "Search failed", error });
    }
});




    // সব রিকোয়েস্ট দেখার এপিআই (Admin/Volunteer এর জন্য)
    app.get("/all-requests", verifyFBToken, async (req, res) => {
      const result = await requestsCollection.find().sort({ createdAt: -1 }).toArray();
      res.send(result);
    });

    app.get("/my-request", verifyFBToken, async (req, res) => {
      const email = req.decoded_email;
      const size = parseInt(req.query.size) || 10;
      const page = parseInt(req.query.page) || 0;
      const query = { requester_email: email };
      const result = await requestsCollection.find(query)
        .skip(page * size).limit(size).toArray();
      const totalRequest = await requestsCollection.countDocuments(query);
      res.send({ request: result, totalRequest });
    });


    // --- Stripe Payment APIs ---
    app.post('/create-payment-checkout', async (req, res) => {
      const info = req.body;
      const amount = parseInt(info.donateAmount) * 100;
      const domain = process.env.SITE_DOMAIN || "http://localhost:5173";
      const session = await stripe.checkout.sessions.create({
        line_items: [{
          price_data: {
            currency: 'usd',
            unit_amount: amount,
            product_data: { name: 'Blood Donation Support' },
          },
          quantity: 1,
        }],
        mode: 'payment',
        metadata: { donorName: info?.donorName },
        customer_email: info?.donorEmail,
        success_url: `${domain}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${domain}/payment-cancelled`,
      });
      res.send({ url: session.url });
    });

    app.post('/success-payment', async (req, res) => {
      try {
        const { session_id } = req.query;
        if (!session_id) return res.status(400).send({ message: "No session ID" });
        const session = await stripe.checkout.sessions.retrieve(session_id);
        const transactionId = session.payment_intent;
        const isExist = await paymentsCollection.findOne({ transactionId });
        if (isExist) return res.send({ message: "Already recorded", transactionId });
        if (session.payment_status === 'paid') {
          const paymentInfo = {
            amount: session.amount_total / 100,
            donorEmail: session.customer_email,
            donorName: session.metadata?.donorName || "Anonymous",
            transactionId,
            paidAt: new Date(),
          };
          const result = await paymentsCollection.insertOne(paymentInfo);
          res.send(result);
        }
      } catch (err) {
        res.status(500).send({ message: "Payment success error" });
      }
    });

    // --- Extra Functionalities ---
    app.get("/all-pending-requests", async (req, res) => {
      const result = await requestsCollection.find({ donation_status: "pending" })
        .sort({ createdAt: -1 }).toArray();
      res.send(result);
    });

    app.get("/request/:id", async (req, res) => {
      const result = await requestsCollection.findOne({ _id: new ObjectId(req.params.id) });
      res.send(result);
    });

    // রিকোয়েস্ট ডিলিট (Admin Only)
    app.delete("/request/delete/:id", verifyFBToken, async (req, res) => {
      const result = await requestsCollection.deleteOne({ _id: new ObjectId(req.params.id) });
      res.send(result);
    });

    // রিকোয়েস্ট স্ট্যাটাস বা ইনফো আপডেট
    app.patch("/requests/donate/:id", async (req, res) => {
      const { donorName, donorEmail, status } = req.body;
      const result = await requestsCollection.updateOne(
        { _id: new ObjectId(req.params.id) },
        { $set: { donor_name: donorName, donor_email: donorEmail, donation_status: status } }
      );
      res.send(result);
    });

    app.get("/my-requests-recent", verifyFBToken, async (req, res) => {
      const result = await requestsCollection.find({ requester_email: req.decoded_email })
        .sort({ createdAt: -1 }).limit(3).toArray();
      res.send(result);
    });

    app.delete("/requests/:id", verifyFBToken, async (req, res) => {
      const result = await requestsCollection.deleteOne({ _id: new ObjectId(req.params.id) });
      res.send(result);
    });

    console.log("Successfully connected to MongoDB!");
  } finally {
    // client open
  }
}
run().catch(console.dir);

app.get("/", (req, res) => res.send("Blood Donation Server is Running"));
app.listen(port, () => console.log(`Server on port ${port}`));