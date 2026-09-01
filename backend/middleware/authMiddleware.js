const { getAuth } = require("firebase-admin/auth");

/*
========================================================
VERIFY FIREBASE AUTH TOKEN
========================================================
*/

async function requireAuth(req, res, next) {
  try {
    const authorization =
      req.headers.authorization || "";

    if (!authorization.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        error: "Authentication required."
      });
    }

    const idToken =
      authorization.substring(7).trim();

    if (!idToken) {
      return res.status(401).json({
        success: false,
        error: "Invalid authentication token."
      });
    }

    const decodedToken =
      await getAuth().verifyIdToken(idToken);

    req.user = {
      uid: decodedToken.uid,
      email: decodedToken.email || "",
      name: decodedToken.name || "",
      emailVerified:
        Boolean(decodedToken.email_verified)
    };

    next();

  } catch (error) {
    console.error(
      "FIREBASE AUTH ERROR:",
      error?.message || error
    );

    return res.status(401).json({
      success: false,
      error:
        "Invalid or expired authentication token."
    });
  }
}

/*
========================================================
REQUIRE ADMIN
========================================================
*/

function requireAdmin(req, res, next) {
  try {
    if (!req.user?.uid) {
      return res.status(401).json({
        success: false,
        error: "Authentication required."
      });
    }

    const adminUserId =
      process.env.ADMIN_USER_ID
        ? process.env.ADMIN_USER_ID.trim()
        : "";

    if (!adminUserId) {
      console.error(
        "ADMIN_USER_ID is not configured."
      );

      return res.status(500).json({
        success: false,
        error:
          "Admin authentication is not configured."
      });
    }

    if (req.user.uid !== adminUserId) {
      console.warn(
        "ADMIN ACCESS DENIED:",
        req.user.uid
      );

      return res.status(403).json({
        success: false,
        error: "Admin access required."
      });
    }

    req.isAdmin = true;

    next();

  } catch (error) {
    console.error(
      "ADMIN AUTH ERROR:",
      error?.message || error
    );

    return res.status(403).json({
      success: false,
      error: "Admin access denied."
    });
  }
}

module.exports = {
  requireAuth,
  requireAdmin
};
