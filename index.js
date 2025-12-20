const { MongoClient, ServerApiVersion } = require("mongodb");
const express = require("express");
const cors = require("cors");
require("dotenv").config();

const port = process.env.PORT || 5000;

const app = express();
app.use(cors());
app.use(express.json());

const admin = require("firebase-admin");

const decoded = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString(
  "utf8"
);
const serviceAccount = JSON.parse(decoded);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const verifyFBToken = async (req, res, next) => {
  const token = req.headers.authorization;

  if (!token) {
    return res.status(401).send({ message: "unauthorize access" });
  }

  try {
    const idToken = token.split(" ")[1];
    const decoded = await admin.auth().verifyIdToken(idToken);
    console.log("decoded info", decoded);
    req.decoded_email = decoded.email;
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
    await client.connect();

    const database = client.db("BloodDonationAppDB");
    const userCollections = database.collection("user");
    const requestsCollection = database.collection("request");

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

      const query = { email: email };
      const result = await userCollections.findOne(query);
      console.log(result);
      res.send(result);
    });

    app.patch("/update/user/status", verifyFBToken, async (req, res) => {
      const { email, status } = req.query;
      const query = { email: email };

      const updataStatus = {
        $set: {
          status: status,
        },
      };

      const result = await userCollections.updateOne(query, updataStatus);

      res.send(result);
    });

    //Donation Request
    app.post("/requests", verifyFBToken, async (req, res) => {
      try {
        const data = req.body;
        data.createdAt = new Date();

        const result = await requestsCollection.insertOne(data);

        res.send(result);
      } catch (error) {
        res.status(500).send({ error: "Failed to add product" });
      }
    });

    app.get("/manager/products/:email", async (req, res) => {
      const email = req.params.email;
      const query = { managerEmail: email };
      const result = await productCollections.find(query).toArray();

      res.send(result);
    });

    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // client.close();
  }
}

run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Hello Developers");
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
