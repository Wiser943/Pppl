// --- THE MASTER KEY CATCHER (Add to your Main Site's script.js) ---
// --- THE MASTER KEY CATCHER (Final Version) ---
const params = new URLSearchParams(window.location.search);
const token = params.get("impersonateToken");

if (token) {
  // 1. Clean the URL immediately so the token disappears
  window.history.replaceState({}, document.title, "/");

  // Allow the Mongo auth module below to initialize.
  setTimeout(() => {
    signInWithCustomToken(auth, token)
      .then(() => {
        sessionStorage.setItem("isImpersonating", "true");
        window.location.reload();
      })
      .catch((err) => {
        console.error("Login failed:", err.message);
        alert(
          "The secure link expired. Please try again from the Admin Panel.",
        );
      });
  }, 500); // 500ms is enough to let the script breathe
}

// ===================== MONGODB API CLIENT ======================
const db = { kind: "database", name: "main" };
const transactionDb = { kind: "database", name: "main" };
const coreNextDb = { kind: "database", name: "main" };
const activeDataListeners = new Set();

function timestampMillis(value) {
  const raw =
    value && typeof value === "object" && "seconds" in value
      ? value.seconds * 1000
      : value;
  const time =
    raw instanceof Date ? raw.getTime() : new Date(raw || 0).getTime();
  return Number.isFinite(time) ? time : 0;
}

class MongoDocumentSnapshot {
  constructor(reference, result) {
    this.ref = reference;
    this.id = result?.id || reference.path.at(-1);
    this._data = result?.data ?? null;
  }
  exists() {
    return this._data !== null;
  }
  data() {
    return this._data;
  }
}

class MongoQuerySnapshot {
  constructor(reference, results, changes = []) {
    this.ref = reference;
    this.docs = results.map(
      (result) =>
        new MongoDocumentSnapshot(
          {
            ...reference,
            kind: "document",
            path: [...reference.path, result.id],
          },
          result,
        ),
    );
    this.empty = this.docs.length === 0;
    this.size = this.docs.length;
    this._changes = changes;
  }
  forEach(callback) {
    this.docs.forEach(callback);
  }
  docChanges() {
    return this._changes;
  }
}

function collection(parent, ...segments) {
  const base = parent.kind === "database" ? [] : parent.path;
  return {
    kind: "collection",
    database: parent.database || parent.name,
    path: [...base, ...segments.map(String)],
    filters: [],
    orders: [],
    maxResults: undefined,
  };
}

function doc(parent, ...segments) {
  if (parent.kind === "collection" && segments.length === 0)
    segments = [crypto.randomUUID()];
  const base = parent.kind === "database" ? [] : parent.path;
  return {
    kind: "document",
    database: parent.database || parent.name,
    path: [...base, ...segments.map(String)],
  };
}

function where(field, operator, value) {
  return { type: "where", value: [field, operator, value] };
}
function orderBy(field, direction = "asc") {
  return { type: "order", value: [field, direction] };
}
function limit(maxResults) {
  return { type: "limit", value: maxResults };
}

function query(reference, ...constraints) {
  const result = {
    ...reference,
    filters: [...(reference.filters || [])],
    orders: [...(reference.orders || [])],
  };
  for (const constraint of constraints) {
    if (constraint.type === "where") result.filters.push(constraint.value);
    if (constraint.type === "order") result.orders.push(constraint.value);
    if (constraint.type === "limit") result.maxResults = constraint.value;
  }
  return result;
}

async function dataRequest(operation, reference, extra = {}) {
  const headers = { "Content-Type": "application/json" };
  const token = sessionStorage.getItem(AUTH_TOKEN_KEY);
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch("/api/data", {
    method: "POST",
    headers,
    body: JSON.stringify({
      operation,
      database: reference.database,
      path: reference.path,
      filters: reference.filters,
      orders: reference.orders,
      maxResults: reference.maxResults,
      ...extra,
    }),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(result?.error || "Data request failed");
  return result;
}

async function getDoc(reference) {
  return new MongoDocumentSnapshot(
    reference,
    await dataRequest("getDoc", reference),
  );
}

async function getDocs(reference) {
  const results = await dataRequest("getDocs", reference);
  return new MongoQuerySnapshot(reference, results || []);
}

async function updateDoc(reference, data) {
  return dataRequest("updateDoc", reference, { data });
}

async function setDoc(reference, data, options = {}) {
  return dataRequest("setDoc", reference, {
    data,
    merge: options.merge === true,
  });
}

async function addDoc(reference, data) {
  const result = await dataRequest("addDoc", reference, { data });
  return { id: result.id, path: [...reference.path, result.id] };
}

function onSnapshot(reference, callback, onError) {
  let stopped = false;
  let running = false;
  let deliveredSnapshot = false;
  let previousDocument;
  let previous = new Map();
  const poll = async () => {
    if (stopped || running) return;
    running = true;
    try {
      if (reference.kind === "document") {
        const snapshot = await getDoc(reference);
        const current = snapshot.exists()
          ? JSON.stringify(snapshot.data())
          : "null";
        if (!deliveredSnapshot || current !== previousDocument)
          callback(snapshot);
        previousDocument = current;
        deliveredSnapshot = true;
      } else {
        const snapshot = await getDocs(reference);
        const current = new Map(
          snapshot.docs.map((document) => [
            document.id,
            JSON.stringify(document.data()),
          ]),
        );
        const changes = [];
        snapshot.docs.forEach((document) => {
          const prior = previous.get(document.id);
          const currentData = current.get(document.id);
          if (prior === undefined)
            changes.push({ type: "added", doc: document });
          else if (prior !== currentData)
            changes.push({ type: "modified", doc: document });
        });
        previous.forEach((_, id) => {
          if (!current.has(id))
            changes.push({
              type: "removed",
              doc: new MongoDocumentSnapshot(
                {
                  ...reference,
                  kind: "document",
                  path: [...reference.path, id],
                },
                { id, data: null },
              ),
            });
        });
        previous = current;
        if (!deliveredSnapshot || changes.length) {
          callback(
            new MongoQuerySnapshot(
              reference,
              snapshot.docs.map((document) => ({
                id: document.id,
                data: document.data(),
              })),
              changes,
            ),
          );
        }
        deliveredSnapshot = true;
      }
    } catch (error) {
      if (onError) onError(error);
      else console.error("Mongo data listener failed:", error);
    } finally {
      running = false;
    }
  };
  void poll();
  const timer = setInterval(poll, 5000);
  const unsubscribe = () => {
    stopped = true;
    clearInterval(timer);
  };
  activeDataListeners.add(unsubscribe);
  return () => {
    unsubscribe();
    activeDataListeners.delete(unsubscribe);
  };
}

const serverTimestamp = () => new Date();
console.log("Mongo data API initialized");

const AUTH_TOKEN_KEY = "mongoSessionToken";
const AUTH_USER_KEY = "mongoSessionUser";
const authListeners = new Set();
let storedUser = null;
try {
  storedUser = JSON.parse(sessionStorage.getItem(AUTH_USER_KEY) || "null");
} catch {
  sessionStorage.removeItem(AUTH_USER_KEY);
}

const auth = {
  currentUser: storedUser,
  onAuthStateChanged(callback) {
    authListeners.add(callback);
    queueMicrotask(() => callback(this.currentUser));
    return () => authListeners.delete(callback);
  },
};

function notifyAuthListeners() {
  authListeners.forEach((callback) => callback(auth.currentUser));
}

function saveMongoSession(token, user) {
  sessionStorage.setItem(AUTH_TOKEN_KEY, token);
  sessionStorage.setItem(AUTH_USER_KEY, JSON.stringify(user));
  auth.currentUser = user;
  notifyAuthListeners();
}

function clearMongoSession() {
  sessionStorage.removeItem(AUTH_TOKEN_KEY);
  sessionStorage.removeItem(AUTH_USER_KEY);
  auth.currentUser = null;
  activeDataListeners.forEach((unsubscribe) => unsubscribe());
  activeDataListeners.clear();
  notifyAuthListeners();
}

async function authRequest(
  action,
  values = {},
  token = sessionStorage.getItem(AUTH_TOKEN_KEY),
) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch("/api/auth", {
    method: "POST",
    headers,
    body: JSON.stringify({ ...values, action }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(result.error || "Authentication request failed");
    error.code = response.status;
    throw error;
  }
  return result;
}

async function walletRequest(action, values = {}) {
  const headers = { "Content-Type": "application/json" };
  const token = sessionStorage.getItem(AUTH_TOKEN_KEY);
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch("/api/wallet", {
    method: "POST",
    headers,
    body: JSON.stringify({ ...values, action }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "Wallet request failed");
  return result;
}

async function signInWithCustomToken(_auth, token) {
  const result = await authRequest("session", {}, token);
  saveMongoSession(token, result.user);
  return { user: result.user };
}

async function signOut() {
  clearMongoSession();
}

function onAuthStateChanged(_auth, callback) {
  return auth.onAuthStateChanged(callback);
}

const currentToken = sessionStorage.getItem(AUTH_TOKEN_KEY);
if (currentToken) {
  authRequest("session", {}, currentToken)
    .then(({ user }) => saveMongoSession(currentToken, user))
    .catch(() => clearMongoSession());
}

let autoClaimStarted = false;
let autoClaimTimer = null;
let isAppInitialized = false;
let balanceAmount; // This will hold your balance display element

window.FintechNotify = {
  base: Swal.mixin({
    toast: true,
    position: "top-end",
    showConfirmButton: false,
    timer: 3200,
    timerProgressBar: true,
    background: "#ffffff",
    color: "#111",
    customClass: {
      popup: "fintech-toast-offset",
    },
  }),

  success(title, text = "") {
    return this.base.fire({ icon: "success", title, text });
  },
  info(title, text = "") {
    return this.base.fire({ icon: "info", title, text });
  },
  warning(title, text = "") {
    return this.base.fire({ icon: "warning", title, text });
  },
  error(title, text = "") {
    return this.base.fire({ icon: "error", title, text });
  },
};

const Toast = Swal.mixin({
  toast: true,
  position: "top-end",
  showConfirmButton: false,
  timer: 3000,
  timerProgressBar: true,
});

const rechargePage = document.getElementById("rechargePage");
const customInput = rechargePage.querySelector("#customAmount");
const amountOptions = rechargePage.querySelectorAll(".amount-option");

// A. Listen to Grid Clicks
amountOptions.forEach((option) => {
  option.addEventListener("click", function () {
    amountOptions.forEach((opt) => opt.classList.remove("active"));
    this.classList.add("active");

    const val = this.dataset.value;
    customInput.value = val;
  });
});

// B. Listen to Custom Input Typing
customInput.addEventListener("input", () => {
  // Optional: Remove active class from grid if user types manually
  amountOptions.forEach((opt) => opt.classList.remove("active"));
});

window.showToast = function (message, type = "success") {
  let container = document.getElementById("toast-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "toast-container";
    document.body.appendChild(container);
  }

  const toast = document.createElement("div");
  toast.className = `modern-toast toast-${type}`;

  // Icon Mapping
  const icons = {
    success: "fa-circle-check",
    error: "fa-circle-xmark",
    warning: "fa-triangle-exclamation",
    info: "fa-circle-info",
  };

  const iconClass = icons[type] || icons.info;

  toast.innerHTML = `
        <i class="fa-solid ${iconClass} toast-icon"></i>
        <span>${message}</span>
    `;

  container.appendChild(toast);

  // Trigger transition
  requestAnimationFrame(() => toast.classList.add("show"));

  // Auto-remove logic
  setTimeout(() => {
    toast.classList.remove("show");
    // Wait for the transition (0.4s) to finish before removing from DOM
    setTimeout(() => toast.remove(), 400);
  }, 3000);
};

let currentDepositId = null;
let countdownTimer = null;

// ======================================================
// CHANGE PAGE
// ======================================================
function changePage(pageId) {
  document.querySelectorAll(".page-section").forEach((page) => {
    page.style.display = "none";
  });

  const target = document.getElementById(pageId);
  if (target) {
    target.style.display = "block";
    localStorage.setItem("lastPage", pageId);
  }
}

// ======================================================
// DOM READY
// ======================================================
document.addEventListener("DOMContentLoaded", () => {
  const wasLoggedIn = localStorage.getItem("isLoggedIn");
  const validPages = [
    "dashboard",
    "productPage",
    "rechargePage",
    "withdrawPage",
    "recordsPage",
    "invitePage",
    "profilePage",
    "bankPage",
    "teamPage",
    "myInvestmentPage",
    "earningsPage",
  ];
  const savedPage = localStorage.getItem("lastPage");
  const safePage = validPages.includes(savedPage) ? savedPage : "dashboard";

  if (wasLoggedIn === "true") {
    // Hide all pages first
    document
      .querySelectorAll(".page-section")
      .forEach((p) => (p.style.display = "none"));

    // Show saved page
    const targetPage = document.getElementById(safePage);
    if (targetPage) targetPage.style.display = "block";

    // Show navbar
    const bottomNav = document.getElementById("bottomNav");
    if (bottomNav) bottomNav.classList.add("open");
  }
});

// ======================================================
// AUTH STATE LISTENER
// ======================================================
onAuthStateChanged(auth, async (user) => {
  const body = document.body;
  const loginContainer = document.getElementById("loginContainer");
  const signupContainer = document.getElementById("signupContainer");
  const dashboard = document.getElementById("dashboard");

  body.classList.remove("auth-loading");

  if (!user) {
    isAppInitialized = false;
    autoClaimStarted = false;
    localStorage.setItem("isLoggedIn", "false");
    localStorage.removeItem("lastPage");

    body.classList.remove("logged-in");

    pages.forEach((p) => {
      if (p) p.style.display = "none";
    });

    const bottomNav = document.getElementById("bottomNav");
    if (bottomNav) bottomNav.classList.remove("open");

    if (signupContainer)
      signupContainer.style.setProperty("display", "none", "important");
    if (loginContainer)
      loginContainer.style.setProperty("display", "block", "important");
    return;
  }

  // USER IS LOGGED IN
  localStorage.setItem("isLoggedIn", "true");
  body.classList.add("logged-in");

  if (loginContainer)
    loginContainer.style.setProperty("display", "none", "important");
  if (signupContainer)
    signupContainer.style.setProperty("display", "none", "important");

  const validPages = [
    "dashboard",
    "productPage",
    "rechargePage",
    "withdrawPage",
    "recordsPage",
    "invitePage",
    "profilePage",
    "bankPage",
    "teamPage",
    "myInvestmentPage",
    "earningsPage",
  ];
  const savedPage = localStorage.getItem("lastPage");
  const safePage = validPages.includes(savedPage) ? savedPage : "dashboard";

  // Hide all pages first
  pages.forEach((p) => {
    if (p) p.style.display = "none";
  });

  // Show saved page
  const pageToDisplay = document.getElementById(safePage);
  if (pageToDisplay) pageToDisplay.style.display = "block";

  // Show navbar
  const bottomNav = document.getElementById("bottomNav");
  if (bottomNav) bottomNav.classList.add("open");

  if (isAppInitialized) return;

  // Only show welcome popup on fresh login not refresh
  if (!savedPage) {
    const welcomePopup = document.getElementById("welcomePopup");
    if (welcomePopup) welcomePopup.style.display = "flex";
  }

  console.log("Initializing user data...");
  await loadBalance();
  startAutoClaim();

  isAppInitialized = true;
});

// ======================================================
// POPUP FUNCTION
// ======================================================
function showWelcomePopup() {
  const welcomePopup = document.getElementById("welcomePopup");
  if (welcomePopup) {
    welcomePopup.style.display = "flex";
  }
}

// ======================================================
// POST-LOGIN (only on fresh login)
// ======================================================
function afterLogin() {
  showWelcomePopup();
}

// ======================================================
// SHOW / HIDE AUTH FORMS
// ======================================================
function showSignup() {
  const loginContainer = document.getElementById("loginContainer");
  const signupContainer = document.getElementById("signupContainer");
  if (loginContainer)
    loginContainer.style.setProperty("display", "none", "important");
  if (signupContainer)
    signupContainer.style.setProperty("display", "block", "important");
}

function showLogin() {
  const signupContainer = document.getElementById("signupContainer");
  const loginContainer = document.getElementById("loginContainer");
  if (signupContainer)
    signupContainer.style.setProperty("display", "none", "important");
  if (loginContainer)
    loginContainer.style.setProperty("display", "block", "important");
}

window.showLogin = showLogin;
window.showSignup = showSignup;

// ======================================================
// PROFILE
// ======================================================
window.openProfile = function () {
  console.log("Profile clicked!");
  const profileModal = document.getElementById("profileModal");
  if (profileModal) profileModal.style.display = "block";
};

function showAlert(message) {
  const alertBox = document.getElementById("customAlert");
  alertBox.textContent = message;
  alertBox.style.opacity = "1";
  alertBox.style.transform = "translateY(0)";

  // Hide after 3 seconds
  setTimeout(() => {
    alertBox.style.opacity = "0";
    alertBox.style.transform = "translateY(-20px)";
  }, 3000);
}

function showLoader(options) {
  const loader = document.getElementById("pageLoader");
  loader.style.display = "flex";
  loader.style.opacity = "1";

  // options: { callback: function, url: string }
  const { callback, url } = options || {};

  setTimeout(() => {
    loader.style.opacity = "0";
    setTimeout(() => {
      loader.style.display = "none";
      if (typeof callback === "function") {
        callback(); // run JS action (signup/login)
      } else if (url) {
        window.location.href = url; // redirect to page
      }
    }, 500); // fade-out duration
  }, 3000); // loader visible for 3 seconds
}

// Function to simulate page load
function loadPage(url) {
  const loader = document.getElementById("pageLoader");
  loader.style.opacity = "1";
  loader.style.display = "flex";

  // After 3 seconds, redirect or show content
  setTimeout(() => {
    loader.style.opacity = "0";
    setTimeout(() => {
      loader.style.display = "none";
      // If real page redirect:
      window.location.href = url;
      // If single-page content, you can instead show/hide sections here
    }, 500);
  }, 3000);
}

// This ensures BOTH buttons are "listening" for a click
document
  .getElementById("googleLoginBtn")
  ?.addEventListener("click", handleGoogleLogin);
document
  .getElementById("googleSignupBtn")
  ?.addEventListener("click", handleGoogleLogin);

// Elements
const signupContainer = document.getElementById("signupContainer");
const loginContainer = document.getElementById("loginContainer");
const dashboard = document.getElementById("dashboard");

// Initial display
signupContainer.classList.add("active");

// --- GLOBAL CONFIG & LOCKS ---
const MS_IN_DAY = 24 * 60 * 60 * 1000;
let isSyncingNow = false; // 🔒 The "Guard" that stops double drops

// ====================== AUTO-FILL REFERRAL ======================
window.addEventListener("DOMContentLoaded", () => {
  const urlParams = new URLSearchParams(window.location.hash.substring(1));
  const ref = urlParams.get("ref");
  if (ref) {
    const referralInput = document.getElementById("referral");
    if (referralInput) referralInput.value = ref;
  }
});

// ====================== SIGNUP ======================
document
  .getElementById("signupForm")
  .addEventListener("submit", async function (e) {
    e.preventDefault();

    const loader = document.getElementById("pageLoader");
    loader.style.display = "flex";
    loader.style.opacity = "1";

    const number = document.getElementById("number").value.trim();
    const password = document.getElementById("password").value.trim();
    const confirmPassword = document
      .getElementById("confirmPassword")
      .value.trim();
    const referral = document.getElementById("referral").value.trim();

    if (!number || !password || !confirmPassword) {
      loader.style.display = "none";
      window.showToast("Validation Failed: All fields are required!", "error");
      return;
    }

    if (password !== confirmPassword) {
      loader.style.display = "none";
      window.showToast("Validation Failed: Passwords do not match!", "error");
      return;
    }
    try {
      const authResult = await authRequest("register", {
        number,
        password,
        referral,
      });
      const user = authResult.user;
      saveMongoSession(authResult.token, user);

      // ✅ Auto-login after signup
      window.showToast("Signup Successful: Logging you in...", "success");

      // Optionally show dashboard immediately
      showDashboard();
      startInvestmentSystem(user.uid);
    } catch (err) {
      console.error("Auth Error Code:", err.code);

      // Default message if we don't recognize the error
      let cleanMessage =
        err.message || "An unexpected error occurred. Please try again.";

      if (err instanceof TypeError || err.message === "Failed to fetch") {
        cleanMessage =
          window.location.protocol === "file:"
            ? "Open the deployed website to sign up. This local file cannot connect to the signup server."
            : "The signup server cannot be reached. Please try again shortly.";
      }

      // 🛡️ CUSTOM CLEAN MESSAGES
      if (err.code === "auth/email-already-in-use") {
        cleanMessage = "This mobile number is already registered.";
      } else if (err.code === "auth/invalid-email") {
        cleanMessage = "Invalid mobile number format.";
      } else if (err.code === "auth/weak-password") {
        cleanMessage =
          "Password is too weak. Please use at least 6 characters.";
      } else if (err.code === "auth/network-request-failed") {
        cleanMessage = "Network error. Please check your connection.";
      } else if (err.code === "auth/operation-not-allowed") {
        cleanMessage = "Signup is currently disabled.";
      }

      window.showToast(`Signup Failed: ${cleanMessage}`, "error");
    } finally {
      // Hide the loader regardless of success or failure
      loader.style.opacity = "0";
      setTimeout(() => {
        loader.style.display = "none";
      }, 500);
    }
  });

// ====================== LOGIN ======================
document
  .getElementById("loginForm")
  .addEventListener("submit", async function (e) {
    e.preventDefault();

    const loader = document.getElementById("pageLoader");
    loader.style.display = "flex";
    loader.style.opacity = "1";

    const loginNumber = document.getElementById("loginNumber").value.trim();
    const loginPassword = document.getElementById("loginPassword").value.trim();
    const fakeEmail = `${loginNumber}@user.com`;

    try {
      // 1️⃣ Sign in user
      const authResult = await authRequest("login", {
        number: loginNumber,
        password: loginPassword,
      });
      const user = authResult.user;
      saveMongoSession(authResult.token, user);

      // Validate the Mongo user profile.
      const userDocRef = doc(db, "users", user.uid);
      const userSnap = await getDoc(userDocRef);

      if (!userSnap.exists()) {
        await signOut(auth);
        window.showToast("User Not Found: User record not found!", "error");
        return;
      }

      if (userSnap.data().banned) {
        await signOut(auth);
        window.showToast(
          "Account Banned: Your account has been banned. Contact support.",
          "error",
        );
        return;
      }

      // 3️⃣ Setup referral (safe, no UI)
      setupReferral(user);

      // 4️⃣ Real-time banned watcher
      onSnapshot(userDocRef, (docSnap) => {
        if (docSnap.exists() && docSnap.data().banned) {
          window.showToast(
            "Account Banned: Your account has been banned. Logging out...",
            "error",
          );
          signOut(auth).then(() => window.location.reload());
        }
      });

      // ❌ NO UI LOGIC HERE
      // Auth state listener will handle dashboard & navbar
    } catch (error) {
      console.error("Login Error Code:", error.code);

      // ✅ PROFESSIONAL SECRECY: Don't tell them if it's the number or the password that is wrong.
      // This stops people from "probing" your database to see who is registered.
      let cleanMessage = "Invalid mobile number or password.";

      if (
        error.code === "auth/user-not-found" ||
        error.code === "auth/wrong-password" ||
        error.code === "auth/invalid-credential"
      ) {
        cleanMessage = "Invalid mobile number or password.";
      } else if (error.code === "auth/user-disabled") {
        cleanMessage =
          "This account has been suspended. Please contact support.";
      } else if (error.code === "auth/too-many-requests") {
        cleanMessage = "Too many failed attempts. Please try again later.";
      } else if (error.code === "auth/network-request-failed") {
        cleanMessage = "Network error. Please check your internet connection.";
      }

      window.showToast(`Login Failed: ${cleanMessage}`, "error");
    } finally {
      loader.style.opacity = "0";
      setTimeout(() => {
        loader.style.display = "none";
      }, 500);
    }
  });

let googleOAuthClientIdPromise;

async function getGoogleAccessToken() {
  const { clientId } = await authRequest("googleConfig", {}, null);
  if (!window.google?.accounts?.oauth2) {
    if (!googleOAuthClientIdPromise) {
      googleOAuthClientIdPromise = new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "https://accounts.google.com/gsi/client";
        script.async = true;
        script.onload = resolve;
        script.onerror = () =>
          reject(new Error("Google sign-in could not load"));
        document.head.appendChild(script);
      });
    }
    await googleOAuthClientIdPromise;
  }

  return new Promise((resolve, reject) => {
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: "openid email profile",
      callback: (result) => {
        if (result.error || !result.access_token) {
          reject(
            new Error(
              result.error_description || "Google sign-in was cancelled",
            ),
          );
          return;
        }
        resolve(result.access_token);
      },
    });
    client.requestAccessToken({ prompt: "select_account" });
  });
}

async function handleGoogleLogin() {
  const loader = document.getElementById("pageLoader");
  loader.style.display = "flex";
  loader.style.opacity = "1";

  try {
    const credential = await getGoogleAccessToken();
    const result = await authRequest("google", { credential });
    const user = result.user;
    saveMongoSession(result.token, user);

    window.showToast("Login Successful!", "success");
    showDashboard();

    // 4. Pass the object directly to the investment system to avoid lag
    startInvestmentSystem(user.uid, user);
  } catch (error) {
    console.error("Google Auth Error:", error);
    window.showToast("Google login failed: " + error.code, "error");
  } finally {
    loader.style.opacity = "0";
    setTimeout(() => {
      loader.style.display = "none";
    }, 500);
  }
}

function escapeCatalogValue(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => {
    const entities = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character];
  });
}

function getCatalogImageUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}

function productImageMarkup(product) {
  const imageUrl = getCatalogImageUrl(product.imageUrl);
  if (!imageUrl)
    return '<div class="mx-plan-media mx-plan-media-empty"><i class="fa-solid fa-cubes-stacked"></i></div>';
  return `<div class="mx-plan-media"><img src="${escapeCatalogValue(imageUrl)}" alt="${escapeCatalogValue(product.name || "Investment plan")}" loading="lazy" referrerpolicy="no-referrer"></div>`;
}

let stopListeningToProducts;

function listenToProducts() {
  const productContainer = document.getElementById("dynamicProductList");
  if (!productContainer) return;

  productContainer.innerHTML = '<div class="mx-loader">Loading Plans...</div>';
  const productsRef = collection(transactionDb, "products");
  stopListeningToProducts?.();

  stopListeningToProducts = onSnapshot(
    productsRef,
    (snapshot) => {
      productContainer.innerHTML = "";
      const productList = [];

      snapshot.forEach((docSnap) => {
        productList.push({ id: docSnap.id, ...docSnap.data() });
      });

      // MASTER SORT
      productList.sort((a, b) => {
        const numA = parseInt(String(a.id).replace(/\D/g, "")) || 0;
        const numB = parseInt(String(b.id).replace(/\D/g, "")) || 0;
        return numA - numB;
      });

      const unlockedProducts = productList.filter((product) => !product.locked);
      if (!unlockedProducts.length) {
        productContainer.innerHTML =
          '<div class="mx-empty-products">Plans are being updated. Please check back soon.</div>';
        return;
      }

      // ── RENDER STUDENT CARD FIRST (top of list) ──────────────────
      const studentPlan = unlockedProducts.find(
        (p) => p.id === "vip0" || p.name?.toLowerCase() === "student",
      );

      if (studentPlan) {
        productContainer.insertAdjacentHTML(
          "beforeend",
          `
        <div class="mx-student-card">
          <div class="mx-student-glow"></div>
          <div class="mx-student-inner">
            ${productImageMarkup(studentPlan)}
            <div class="mx-student-top">
              <div class="mx-student-badge">🎓 STARTER PLAN</div>
              <div class="mx-student-cycle">${studentPlan.cycle || 0} Days</div>
            </div>
            <div class="mx-student-name">${escapeCatalogValue(studentPlan.name)}</div>
            <div class="mx-student-tagline">Perfect for beginners — start small, earn daily</div>
            <div class="mx-student-stats">
              <div class="mx-student-stat">
                <div class="mx-student-stat-label">Investment</div>
                <div class="mx-student-stat-val">₦${Number(studentPlan.price || 0).toLocaleString()}</div>
              </div>
              <div class="mx-student-divider"></div>
              <div class="mx-student-stat">
                <div class="mx-student-stat-label">Daily Income</div>
                <div class="mx-student-stat-val gold">₦${Number(studentPlan.dailyIncome || 0).toLocaleString()}</div>
              </div>
              <div class="mx-student-divider"></div>
              <div class="mx-student-stat">
                <div class="mx-student-stat-label">Total Revenue</div>
                <div class="mx-student-stat-val">₦${Number(studentPlan.totalIncome || 0).toLocaleString()}</div>
              </div>
            </div>
            <button class="mx-student-btn mx-add-to-portfolio-btn"
              data-name="${escapeCatalogValue(studentPlan.name)}"
              data-price="${Number(studentPlan.price || 0)}"
              data-daily="${Number(studentPlan.dailyIncome || 0)}"
              data-cycle="${Number(studentPlan.cycle || 0)}">
              🎓 Start Earning Now
            </button>
          </div>
        </div>
      `,
        );
      }

      // ── RENDER REMAINING PLANS (skip student) ─────────────────────
      const regularPlans = unlockedProducts.filter(
        (p) => p.id !== "vip0" && p.name?.toLowerCase() !== "student",
      );

      regularPlans.forEach((p, index) => {
        // VIP divider before the 9th item
        if (index === 8) {
          productContainer.insertAdjacentHTML(
            "beforeend",
            `
          <div class="vip-divider">
            <div class="vip-shine"></div>
            <h2 class="vip-text">ELITE VIP PLANS</h2>
            <p>Exclusive High-Yield Opportunities</p>
          </div>
        `,
          );
        }

        const icon = index < 8 ? "🔥" : "💎";

        const cardHtml = `
        <div class="mx-product-card">
          <div class="mx-card-body">
            ${productImageMarkup(p)}
            <div class="mx-card-header-area">
              <h3 class="mx-plan-name">${icon} ${escapeCatalogValue(p.name || "Plan")}</h3>
              <div class="mx-duration-badge">${p.cycle || 0} Days</div>
            </div>
            <div class="mx-price-section">
              <span class="mx-price-label">Investment</span>
              <span class="mx-main-price">₦${Number(p.price || 0).toLocaleString()}</span>
            </div>
            <div class="mx-info-grid">
              <div class="mx-grid-cell">
                <div class="mx-cell-label">Daily Income</div>
                <div class="mx-cell-value mx-gold-glow">₦${Number(p.dailyIncome || 0).toLocaleString()}</div>
              </div>
              <div class="mx-grid-cell">
                <div class="mx-cell-label">Total Revenue</div>
                <div class="mx-cell-value">₦${Number(p.totalIncome || 0).toLocaleString()}</div>
              </div>
            </div>
            <button class="mx-add-to-portfolio-btn"
              data-name="${escapeCatalogValue(p.name || "Plan")}"
              data-price="${Number(p.price || 0)}"
              data-daily="${Number(p.dailyIncome || 0)}"
              data-cycle="${Number(p.cycle || 0)}">
              Invest Now
            </button>
          </div>
        </div>
      `;
        productContainer.insertAdjacentHTML("beforeend", cardHtml);
      });

      productContainer
        .querySelectorAll(".mx-plan-media img")
        .forEach((image) => {
          image.addEventListener(
            "error",
            () => {
              image.parentElement.classList.add("mx-plan-media-empty");
              image.parentElement.innerHTML =
                '<i class="fa-solid fa-cubes-stacked"></i>';
            },
            { once: true },
          );
        });
    },
    (error) => {
      console.error("Error fetching products:", error);
      productContainer.innerHTML =
        '<div class="mx-error">Failed to load plans.</div>';
    },
  );
}

document
  .getElementById("dynamicProductList")
  .addEventListener("click", async (e) => {
    const btn = e.target.closest(".mx-add-to-portfolio-btn");
    if (!btn || btn.dataset.processing === "true") return;

    const name = btn.dataset.name;
    const price = parseFloat(btn.dataset.price);
    const daily = parseFloat(btn.dataset.daily);
    const cycle = parseInt(btn.dataset.cycle);

    btn.dataset.processing = "true";
    const originalText = btn.innerText;
    btn.innerText = "Processing...";
    btn.style.opacity = "0.6";
    btn.style.cursor = "not-allowed";

    try {
      await showLoader({
        callback: async () => {
          await handleInvestment(price, daily, cycle, name);
        },
      });
    } catch (err) {
      console.error("Investment failed:", err);
    } finally {
      btn.dataset.processing = "false";
      btn.innerText = originalText;
      btn.style.opacity = "1";
      btn.style.cursor = "pointer";
    }
  });

listenToProducts();

auth.onAuthStateChanged(async (user) => {
  if (!user) return; // user not signed in, do nothing

  try {
    const userRef = doc(db, "users", user.uid);
    const userSnap = await getDoc(userRef);

    let bonus = 0;

    if (userSnap.exists()) {
      const data = userSnap.data();
      bonus = data.bonus || 0;
    }
  } catch (error) {
    console.error("Error fetching user bonus:", error);
  }
});

auth.onAuthStateChanged(async (user) => {
  if (!user) return;

  const userSnap = await getDoc(doc(db, "users", user.uid));
  if (!userSnap.exists()) return;

  const balance = userSnap.data().balance || 0;
  document.getElementById("userBalance").textContent = balance.toLocaleString();
});

onAuthStateChanged(auth, (user) => {
  if (user) {
  }
});

auth.onAuthStateChanged(async (user) => {
  if (!user) return;

  // Retry up to 5 times with 1s delay
  // Retry briefly while signup finishes writing the profile.
  let snap = null;
  for (let i = 0; i < 5; i++) {
    snap = await getDoc(doc(db, "users", user.uid));
    if (snap.exists()) break;
    await new Promise((res) => setTimeout(res, 1000));
  }

  if (!snap || !snap.exists()) return;

  const data = snap.data();

  // PHONE NUMBER (top-left label)
  const phoneEl = document.getElementById("userPhoneNumber");
  if (phoneEl) {
    if (data.number && data.number !== "Google User") {
      phoneEl.innerText = data.number;
    } else if (data.email) {
      const name = data.email.split("@")[0];
      phoneEl.innerText = name.charAt(0).toUpperCase() + name.slice(1);
    } else {
      phoneEl.innerText = "User";
    }
  }

  // BALANCE
  const balanceEl = document.getElementById("balanceAmount");
  if (balanceEl) {
    balanceEl.innerText = `₦${(data.balance || 0).toLocaleString()}`;
  }
});

// Wait for the DOM to fully load before running the slider logic
document.addEventListener("DOMContentLoaded", () => {
  const track = document.getElementById("flyerTrack");

  // Guard clause: Only run if the element exists on the current page view
  if (!track) return;

  let currentSlide = 0;
  const totalSlides = 2; // We have exactly 2 premium images
  const slideIntervalTime = 3000; // Time in milliseconds (3000ms = 3 seconds)

  function startPremiumSlider() {
    currentSlide++;

    // If it reaches the end, reset back to the first image seamlessly
    if (currentSlide >= totalSlides) {
      currentSlide = 0;
    }

    // Move the track smoothly by shifting it to the left
    // Slide 0: 0% | Slide 1: -50% | Slide 2: -100%
    const nextPercentage = -(currentSlide * (100 / totalSlides));
    track.style.transform = `translateX(${nextPercentage}%)`;
  }

  // Set the slide to change automatically every 3 seconds
  setInterval(startPremiumSlider, slideIntervalTime);
});

async function logout() {
  const loader = document.getElementById("pageLoader");
  loader.style.display = "flex";
  loader.style.opacity = "1";

  try {
    // 1. Stop background processes so they don't try to update a logged-out UI
    if (typeof investmentInterval !== "undefined")
      clearInterval(investmentInterval);

    // 2. Clear the Mongo session
    await signOut(auth);

    // 3. Clear local storage
    localStorage.removeItem("lastPage");
    localStorage.setItem("isLoggedIn", "false");

    // 4. Reload the page
    // This triggers onAuthStateChanged, which will naturally
    // hide the dashboard and show the login screen.
    window.location.reload();
  } catch (err) {
    console.error("Logout failed:", err);
    loader.style.opacity = "0";
    setTimeout(() => {
      loader.style.display = "none";
    }, 500);
    window.showToast("Logout failed, please try again.", "error");
  }
}

window.logout = logout;

document.addEventListener("DOMContentLoaded", () => {
  const checkInBtn = document.getElementById("supportBtn");

  if (checkInBtn)
    checkInBtn.addEventListener("click", async () => {
      const loader = document.getElementById("dailyLoader");
      loader.style.display = "flex";

      const user = auth.currentUser;

      if (!user) {
        loader.style.display = "none";
        window.showToast("Please Login: You must be logged in!", "warning");
        return;
      }

      const userRef = doc(db, "users", user.uid);

      try {
        const today = new Date().toISOString().split("T")[0];

        const userSnap = await getDoc(userRef);
        if (!userSnap.exists()) {
          loader.style.display = "none";
          return;
        }

        const userData = userSnap.data();

        // Check active investment
        const hasActiveInvestment =
          Array.isArray(userData.investments) &&
          userData.investments.some((inv) => inv.status === "active");

        if (!hasActiveInvestment) {
          loader.style.display = "none";
          window.showToast(
            "Need to Purchase a Product: Please purchase a product to continue.",
            "warning",
          );
          return;
        }

        // Already claimed
        if (userData.lastDailyClaim === today) {
          loader.style.display = "none";

          FintechNotify.info(
            "Check-in completed",
            "You’ve already checked in today. Come back tomorrow.",
          );

          return;
        }
        // Give bonus
        const claimResult = await walletRequest("dailyClaim");
        const balanceElem = document.getElementById("balanceAmount");
        if (balanceElem)
          balanceElem.textContent = `₦${claimResult.balance.toLocaleString()}`;

        window.showToast("Daily Login Successful: 🎁 ₦100 added.", "success");
        loader.style.display = "none";
      } catch (err) {
        console.error("Daily login error:", err);
        loader.style.display = "none";
        window.showToast(
          "Failed to Claim Daily Reward: Please try again later.",
          "error",
        );
      }
    });
});

auth.onAuthStateChanged((user) => {
  if (!user) return;

  const userRef = doc(db, "users", user.uid);

  onSnapshot(userRef, async (snap) => {
    const data = snap.data();
    if (!data) return;

    // -------------------- Update dashboard balance --------------------
    const balanceAmount = document.getElementById("balanceAmount");
    if (balanceAmount) {
      balanceAmount.textContent = `₦${data.balance.toLocaleString()}`;
    }

    // -------------------- Update total commission --------------------
    const totalCommissionEl = document.getElementById("totalCommission");
    if (totalCommissionEl) {
      const commissionsCol = collection(userRef, "commissions");
      const commissionsSnap = await getDocs(commissionsCol);
      let totalCommission = 0;
      commissionsSnap.forEach((doc) => {
        const c = doc.data();
        totalCommission += c.amount || 0;
      });
      totalCommissionEl.textContent = `Total Commission: ₦${totalCommission.toLocaleString()}`;
    }

    // -------------------- Update team summary --------------------
    const totalReferralsEl = document.getElementById("totalReferrals");
    if (totalReferralsEl) {
      const level1Count = data.referrals?.level1?.length || 0;
      const level2Count = data.referrals?.level2?.length || 0;
      totalReferralsEl.textContent = `Total Referrals: ${level1Count + level2Count}`;
    }
  });
});

function openProfile() {
  // Hide all pages safely
  localStorage.setItem("lastPage", "profilePage"); // ADD THIS
  sessionStorage.setItem("currentPage", "profilePage"); // ADD THIS
  if (pages && pages.length) {
    pages.forEach((page) => {
      if (page) page.style.display = "none";
    });
  }

  if (productPage) productPage.style.display = "none";

  const profilePage = document.getElementById("profilePage");
  if (profilePage) profilePage.style.display = "block";

  const bottomNav = document.getElementById("bottomNav");
  if (bottomNav) bottomNav.style.display = "flex";
}

// Make it global
window.openProfile = openProfile;

function showDashboard() {
  const loader = document.getElementById("pageLoader");
  loader.style.display = "flex";
  loader.style.opacity = "1";

  setTimeout(() => {
    // Hide other pages
    document.getElementById("profilePage").style.display = "none";
    document.getElementById("productPage").style.display = "none";
    document.getElementById("bankPage").style.display = "none";

    // Show dashboard
    document.getElementById("dashboard").style.display = "block";

    // Show bottom nav
    document.getElementById("bottomNav").style.display = "flex";

    // Show welcome popup
    showWelcomePopup();

    // Hide loader
    loader.style.opacity = "0";
    setTimeout(() => {
      loader.style.display = "none";
    }, 500);
  }, 500); // small delay so loader is visible
}

// Make it global
window.showDashboard = showDashboard;

function backToProfile() {
  const loader = document.getElementById("pageLoader");
  loader.style.display = "flex";
  loader.style.opacity = "1";

  setTimeout(() => {
    // Hide bank page
    document.getElementById("bankPage").style.display = "none";
    // Show profile page
    document.getElementById("profilePage").style.display = "block";

    // Show nav
    document.getElementById("bottomNav").style.display = "flex";

    // Hide loader
    loader.style.opacity = "0";
    setTimeout(() => {
      loader.style.display = "none";
    }, 500);
  }, 500); // small delay so loader is visible
}

// Make it global
window.backToProfile = backToProfile;

// ----------------- Bank Navigation (Unified) -----------------
function openBankPage() {
  const loader = document.getElementById("pageLoader");
  loader.style.display = "flex";
  loader.style.opacity = "1";

  setTimeout(() => {
    // Hide all pages
    pages.forEach((page) => {
      if (page) page.style.display = "none";
    });

    // Show bank page
    document.getElementById("bankPage").style.display = "block";

    // FORCE HIDE BOTTOM NAVIGATION
    const bottomNav = document.getElementById("bottomNav"); // Put your bottom nav ID here
    if (bottomNav) bottomNav.style.display = "none";

    loader.style.opacity = "0";
    setTimeout(() => (loader.style.display = "none"), 500);
  }, 300);
}

// Bank icon click
document
  .getElementById("bankAccountBtn")
  .addEventListener("click", openBankPage);

// Dynamic Add Account button click
document.addEventListener("click", function (e) {
  if (e.target.id === "addAccountBtn") {
    openBankPage();
  }
});

// ----------------- References -----------------
const bankForm = document.getElementById("bankForm");
const bankSuccess = document.getElementById("bankSuccess");
const withdrawBankCard = document.getElementById("withdrawBankCard");
const addAccountBtn = document.getElementById("addAccountBtn");
const plusIcon = withdrawBankCard
  ? withdrawBankCard.querySelector(".plus-icon-circle")
  : null;
const withdrawBankName = document.getElementById("withdrawBankName"); // "No Bank Account Added"
const bankDetailsDisplay = document.getElementById("bankDetailsDisplay");
const withdrawBankNameDisplay = document.getElementById(
  "withdrawBankNameDisplay",
); // Bank Name display
const withdrawAccountNumber = document.getElementById("withdrawAccountNumber");
const withdrawAccountName = document.getElementById("withdrawAccountName");

// Form Element Variable Definitions
const bankSelect = document.getElementById("bankName");
const accNumInput = document.getElementById("accountNumber");
const accNameInput = document.getElementById("accountName");

// -------------------------------------------------------------------------
// REFACTORED BANK INFO SETTINGS (Single Auth Listener + Submission Logic)
// -------------------------------------------------------------------------

// Helper to get submit button
const getSubmitBtn = () =>
  bankForm?.querySelector(".honda-submit-btn") ||
  bankForm?.querySelector('button[type="submit"]');

// 1. Auth Listener (The unified source of truth)
auth.onAuthStateChanged((user) => {
  if (!user) return;

  const userRef = doc(db, "users", user.uid);

  onSnapshot(userRef, (snap) => {
    const bank = snap.data()?.bankAccount;
    const displayCard = document.getElementById("bankDetailsDisplay");
    const submitBtn = getSubmitBtn();
    const addAccountBtn = document.getElementById("addAccountBtn");
    const plusIcon = document.getElementById("plusIcon");
    const withdrawBankName = document.getElementById("withdrawBankName");

    if (bank) {
      // --- UI: SHOW SAVED INFO ---
      if (displayCard) displayCard.style.display = "block";
      if (addAccountBtn) addAccountBtn.style.display = "none";
      if (plusIcon) plusIcon.style.display = "none";
      if (withdrawBankName) withdrawBankName.style.display = "block";

      // Translate Bank Code to Name
      let bankLetters = bank.bankName;
      const bankDropdown = document.getElementById("bankName");
      if (bankDropdown) {
        const matchingOption = Array.from(bankDropdown.options).find(
          (opt) => opt.value === bank.bankName,
        );
        if (matchingOption) bankLetters = matchingOption.text;
      }

      // Update Display Card
      if (document.getElementById("withdrawBankNameDisplay"))
        document.getElementById("withdrawBankNameDisplay").textContent =
          bankLetters;
      if (document.getElementById("withdrawAccountName"))
        document.getElementById("withdrawAccountName").textContent =
          bank.accountName;

      // Mask Account Number
      const raw = bank.accountNumber;
      const withdrawAccountNumber = document.getElementById(
        "withdrawAccountNumber",
      );
      if (withdrawAccountNumber) {
        withdrawAccountNumber.textContent =
          raw && raw.length >= 10
            ? `${raw.slice(0, 4)} **** ${raw.slice(-4)}`
            : raw;
      }

      // Lock Form & Hide Submit
      if (accNumInput) {
        accNumInput.value = bank.accountNumber;
        accNumInput.disabled = true;
      }
      if (accNameInput) {
        accNameInput.value = bank.accountName;
        accNameInput.disabled = true;
      }
      if (bankSelect) {
        bankSelect.value = bank.bankName;
        bankSelect.disabled = true;
      }
      if (submitBtn) submitBtn.style.display = "none";
      if (bankSuccess) {
        bankSuccess.style.display = "block";
        bankSuccess.textContent = "Bank info saved permanently ✅";
      }
    } else {
      // --- UI: SHOW ADD ACCOUNT STATE ---
      if (displayCard) displayCard.style.display = "none";
      if (addAccountBtn) addAccountBtn.style.display = "block";
      if (plusIcon) plusIcon.style.display = "flex";
      if (submitBtn) submitBtn.style.display = "block";
      if (bankSuccess) bankSuccess.style.display = "none";

      // Unlock Inputs
      if (accNumInput) {
        accNumInput.disabled = false;
        accNumInput.value = "";
      }
      if (accNameInput) {
        accNameInput.disabled = false;
        accNameInput.value = "";
      }
      if (bankSelect) {
        bankSelect.disabled = false;
        bankSelect.value = "";
      }
    }
  });
});

// 2. Submission Logic
if (bankForm) {
  bankForm.addEventListener("submit", async function (e) {
    e.preventDefault();

    const submitBtn = getSubmitBtn();
    const originalBtnText = submitBtn?.innerText || "Update Details";

    // Get absolute values for checking
    const accountNameValue = accNameInput ? accNameInput.value.trim() : "";

    // --- STRICT VALIDATION RULES ---
    if (!bankSelect || !bankSelect.value) {
      return window.showToast("Please select your bank.", "warning");
    }
    if (!accNumInput || accNumInput.value.trim().length !== 10) {
      return window.showToast("Account number must be 10 digits!", "warning");
    }

    // Strict Error & Status Phrase Protection Blocks
    if (
      !accountNameValue ||
      accountNameValue.includes("Awaiting") ||
      accountNameValue.toLowerCase().includes("verifying") ||
      accountNameValue.toLowerCase().includes("failed") ||
      accountNameValue.toLowerCase().includes("error")
    ) {
      return window.showToast(
        "Please wait for a valid account verification before saving.",
        "error",
      );
    }

    if (submitBtn) {
      submitBtn.innerText = "Saving permanently...";
      submitBtn.disabled = true;
    }
    try {
      const userRef = doc(db, "users", auth.currentUser.uid);
      await updateDoc(userRef, {
        bankAccount: {
          bankName: bankSelect.options[bankSelect.selectedIndex].text, // ✅ human readable name
          bankCode: bankSelect.value, // ✅ actual bank code for API
          accountNumber: accNumInput.value.trim(),
          accountName: accountNameValue,
        },
      });
      window.showToast("Bank Account Saved Successfully!", "success");
    } catch (err) {
      console.error("Save Error:", err);
      window.showToast("Failed to save. Check connection.", "error");
      if (submitBtn) {
        submitBtn.innerText = originalBtnText;
        submitBtn.disabled = false;
      }
    }
  });
}

// Make Home icon show dashboard
document.getElementById("homeNav").addEventListener("click", function (e) {
  e.preventDefault(); // prevent default link behavior
  showDashboard(); // call your existing function
});

// Select elements
// We changed this from .withdraw-max to #withdrawMaxBtn
const maxBtn = document.getElementById("withdrawMaxBtn");
const balanceEl = document.getElementById("withdrawBalance");
const inputEl = document.getElementById("withdrawAmountInput");

// Add a safety check so it doesn't crash if the button is missing
if (maxBtn && balanceEl && inputEl) {
  maxBtn.addEventListener("click", () => {
    // Get balance text (e.g. "₦12,500")
    let balanceText = balanceEl.textContent;

    // Remove currency symbol and commas
    let cleanBalance = balanceText.replace(/[₦,]/g, "").trim();

    // Set it into input
    inputEl.value = cleanBalance;
  });
} else {
  console.log("Withdrawal elements not found on this page.");
}
// Elements
const dailyChip = document.getElementById("dailyChip");
const dailyLabel = document.getElementById("dailyLabel");

const dailyReward = 50;

async function loadBalance() {
  const user = auth.currentUser;
  if (!user) return;

  // We connect the variable to the ID in your HTML
  balanceAmount = document.getElementById("withdrawBalance");

  const userRef = doc(db, "users", user.uid);
  const userSnap = await getDoc(userRef);
  if (!userSnap.exists()) return;

  const data = userSnap.data();

  // Update the text only if the element was found
  if (balanceAmount) {
    balanceAmount.textContent = `₦${(data.balance || 0).toLocaleString()}`;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  // ── DOM ──────────────────────────────────────────────────────────
  const rechargePage = document.getElementById("rechargePage");
  const payPage = document.getElementById("payPage");
  const dashboard = document.getElementById("dashboard");
  const bottomNav = document.getElementById("bottomNav");
  const rechargeBackBtn = document.getElementById("rechargeBackBtn");
  const payBackBtn = document.getElementById("payBackBtn");
  const confirmPayBtn = document.getElementById("confirmPayBtn");

  const rechargeTriggers = document.querySelectorAll(
    ".qa-btn.recharge, #mainRechargeTrigger, .action-btn#depositBtn",
  );

  let selectedAmt = 3000;
  let payTimerInterval = null;

  // ── CACHE ────────────────────────────────────────────────────────
  const _cache = {
    userPhone: null,
    depositHistory: null, // { isFirst: bool, firstAmount: number|null }
  };

  // Phone — localStorage first, Mongo profile once
  async function _getPhone(user) {
    if (_cache.userPhone) return _cache.userPhone;
    const stored = localStorage.getItem("u_phone");
    if (stored && stored !== "N/A") {
      _cache.userPhone = stored;
      return _cache.userPhone;
    }
    const snap = await getDoc(doc(db, "users", user.uid));
    const phone = snap.exists() ? snap.data().number || "N/A" : "N/A";
    if (phone !== "N/A") localStorage.setItem("u_phone", phone);
    _cache.userPhone = phone;
    return _cache.userPhone;
  }

  // Deposit history — one Mongo query max per session
  // Returns { isFirst, firstAmount }
  async function _getDepositHistory(uid) {
    if (_cache.depositHistory !== null) return _cache.depositHistory;

    // Get all approved deposits for this user ordered by time
    const q = query(
      collection(transactionDb, "manualDeposits"),
      where("uid", "==", uid),
      where("status", "==", "approved"),
      limit(5),
    );
    const snap = await getDocs(q);

    if (snap.empty) {
      // No approved deposits yet — this is first
      _cache.depositHistory = { isFirst: true, firstAmount: null };
    } else {
      // Has approved deposits — find the first one by timestamp
      const docs = [];
      snap.forEach((d) => docs.push(d.data()));
      // Sort by timestamp ascending to get earliest
      docs.sort((a, b) => {
        return timestampMillis(a.timestamp) - timestampMillis(b.timestamp);
      });
      _cache.depositHistory = {
        isFirst: false,
        firstAmount: Number(docs[0].amount),
      };
    }

    return _cache.depositHistory;
  }

  function _bustDepositCache() {
    _cache.depositHistory = null;
  }

  // ── OPEN RECHARGE PAGE ───────────────────────────────────────────
  rechargeTriggers.forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!rechargePage) return;
      if (typeof showLoader === "function") {
        showLoader({
          callback: () => {
            if (typeof pages !== "undefined") {
              pages.forEach((p) => {
                if (p) p.style.display = "none";
              });
            }
            if (dashboard) dashboard.style.display = "none";
            if (bottomNav) bottomNav.style.display = "none";
            rechargePage.style.display = "block";
          },
        });
      } else {
        if (dashboard) dashboard.style.display = "none";
        if (bottomNav) bottomNav.style.display = "none";
        rechargePage.style.display = "block";
      }
    });
  });

  // ── AMOUNT SELECTION ─────────────────────────────────────────────
  if (rechargePage) {
    const amountOptions = rechargePage.querySelectorAll(".amount-option");
    const customInput = rechargePage.querySelector("#customAmount");
    const depositBtn = rechargePage.querySelector("#depositBtn");

    amountOptions.forEach((option) => {
      option.addEventListener("click", function () {
        amountOptions.forEach((opt) => opt.classList.remove("active"));
        this.classList.add("active");
        if (customInput) customInput.value = this.dataset.value;
        selectedAmt = Number(this.dataset.value);
      });
    });

    if (customInput) {
      customInput.addEventListener("input", () => {
        amountOptions.forEach((opt) => opt.classList.remove("active"));
        selectedAmt = Number(customInput.value);
      });
    }

    // ── DEPOSIT BTN → FETCH FROM MONGO API → LOADER → PAY PAGE ──
    if (depositBtn) {
      depositBtn.addEventListener("click", async () => {
        const amount = Number(customInput?.value) || selectedAmt;
        const user = auth?.currentUser;

        if (!user) {
          Swal.fire({
            icon: "warning",
            title: "Login Required",
            html: '<p style="opacity:.8">Please login to continue</p>',
            background: "#FFFFFF",
            color: "#3B82F6",
            confirmButtonColor: "#3B82F6",
          });
          return;
        }

        if (!amount || amount < 3000) {
          Swal.fire({
            icon: "warning",
            title: "Minimum Not Met",
            html: '<p style="opacity:.8">Minimum deposit is ₦3,000</p>',
            background: "#FFFFFF",
            color: "#3B82F6",
            confirmButtonColor: "#3B82F6",
          });
          return;
        }

        // ── SHOW LOADER ──────────────────────────────────────────
        Swal.fire({
          title:
            '<span style="color:#3B82F6;font-size:17px;font-weight:700;">Preparing Payment</span>',
          html: `
        <div style="text-align:center;padding:8px 0 4px;">
          <div style="width:48px;height:48px;border:3px solid #2A2825;border-top:3px solid #3B82F6;border-radius:50%;margin:0 auto 14px;animation:rcSpin .8s linear infinite;"></div>
          <style>@keyframes rcSpin{to{transform:rotate(360deg)}}</style>
          <p style="margin:0;color:#9CA3AF;font-size:13px;">Fetching account details...</p>
        </div>
      `,
          background: "#FFFFFF",
          allowOutsideClick: false,
          showConfirmButton: false,
        });

        try {
          // ── FETCH LIVE DATA FROM MONGO API ──────────────────────
          const docRef = doc(db, "adminSettings", "settings");
          const docSnap = await getDoc(docRef);

          if (!docSnap.exists()) {
            throw new Error("Settings document not found");
          }

          const data = docSnap.data();
          // Accessing the 'bankAccount' map inside the document
          const bankData = data.bankAccount;

          if (!bankData) {
            throw new Error("Bank account map missing");
          }

          const accountDetails = {
            name: bankData.accountName,
            bank: bankData.bankName,
            account: bankData.accountNumber,
            note:
              "ZG" + Math.random().toString(36).substring(2, 10).toUpperCase(),
          };

          Swal.close();
          showPayPage(amount, accountDetails);
        } catch (error) {
          console.error("Error fetching account:", error);
          Swal.close();
          Swal.fire({
            icon: "error",
            title: "Payment Error",
            text: "Could not fetch payment details. Please try again.",
            background: "#FFFFFF",
            color: "#3B82F6",
          });
        }
      });
    }
  }

  // ── BACK BUTTONS ─────────────────────────────────────────────────
  if (rechargeBackBtn) {
    rechargeBackBtn.addEventListener("click", () => {
      rechargePage.style.display = "none";
      if (dashboard) dashboard.style.display = "block";
      if (bottomNav) bottomNav.style.display = "flex";
    });
  }

  if (payBackBtn) {
    payBackBtn.addEventListener("click", () => {
      clearInterval(payTimerInterval);
      payPage.style.display = "none";
      rechargePage.style.display = "block";
    });
  }

  // ── SHOW PAY PAGE ────────────────────────────────────────────────
  function showPayPage(amount, details) {
    document.getElementById("payAmount").textContent =
      Number(amount).toLocaleString();
    document.getElementById("payAmountRow").textContent =
      Number(amount).toLocaleString();
    document.getElementById("payAccountName").textContent = details.name;
    document.getElementById("payBankName").textContent = details.bank;
    document.getElementById("payAccountNumber").textContent = details.account;
    document.getElementById("payNote").textContent = details.note;

    rechargePage.style.display = "none";
    payPage.style.display = "block";

    startPayTimer(1799);
  }

  // ── COUNTDOWN TIMER ──────────────────────────────────────────────
  function startPayTimer(seconds) {
    clearInterval(payTimerInterval);
    const timerEl = document.getElementById("payTimer");

    payTimerInterval = setInterval(() => {
      const mins = Math.floor(seconds / 60);
      const secs = seconds % 60;
      timerEl.textContent = `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;

      if (seconds <= 60) timerEl.classList.add("urgent");

      if (seconds <= 0) {
        clearInterval(payTimerInterval);
        timerEl.textContent = "00:00";
        Swal.fire({
          icon: "error",
          title: "Time Expired",
          html: '<p style="opacity:.8">Your session expired. Please start a new deposit.</p>',
          background: "#FFFFFF",
          color: "#3B82F6",
          confirmButtonColor: "#3B82F6",
        }).then(() => {
          payPage.style.display = "none";
          rechargePage.style.display = "block";
        });
      }
      seconds--;
    }, 1000);
  }

  // ── COPY TO CLIPBOARD ────────────────────────────────────────────
  window.copyText = function (elementId) {
    const el = document.getElementById(elementId);
    const btn = el.nextElementSibling;
    navigator.clipboard.writeText(el.innerText).then(() => {
      btn.style.background = "#3B82F6";
      btn.style.color = "#FFFFFF";
      setTimeout(() => {
        btn.style.background = "";
        btn.style.color = "";
      }, 1000);
    });
  };

  // ── I HAVE PAID → POPUP FORM ─────────────────────────────────────
  if (confirmPayBtn) {
    confirmPayBtn.addEventListener("click", () => showPayerForm());
  }

  function showPayerForm() {
    payPage.style.filter = "blur(4px)";
    payPage.style.pointerEvents = "none";

    const overlay = document.createElement("div");
    overlay.id = "payerOverlay";
    overlay.style.cssText = `
      position:fixed;inset:0;z-index:9999;
      display:flex;align-items:flex-end;justify-content:center;
      background:rgba(7,7,6,0.6);
      backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);
    `;

    overlay.innerHTML = `
      <div style="
        background:#1a1917;border:1px solid #2A2825;
        border-radius:28px 28px 0 0;padding:28px 20px 40px;
        width:100%;max-width:480px;
      ">
        <div style="width:40px;height:4px;background:#2A2825;border-radius:4px;margin:0 auto 24px;"></div>
        <h3 style="margin:0 0 6px;font-size:18px;font-weight:700;color:#3B82F6;text-align:center;">
          Confirm Your Transfer
        </h3>
        <p style="margin:0 0 24px;font-size:13px;color:#9CA3AF;text-align:center;">
          Fill in your sender details so admin can verify your payment
        </p>
        <label style="display:block;font-size:12px;font-weight:600;color:#3B82F6;
          letter-spacing:1px;text-transform:uppercase;margin-bottom:8px;">
          Payer's Name
        </label>
        <input id="popupPayerName" type="text" placeholder="e.g. John Doe" style="
          width:100%;height:54px;border:2px solid #2A2825;border-radius:14px;
          padding:0 16px;font-size:15px;font-weight:600;color:#3B82F6;
          background:#FFFFFF;outline:none;box-sizing:border-box;
          font-family:'Inter',sans-serif;margin-bottom:14px;
        ">
        <label style="display:block;font-size:12px;font-weight:600;color:#3B82F6;
          letter-spacing:1px;text-transform:uppercase;margin-bottom:8px;">
          Payer's Account Number
        </label>
        <input id="popupPayerAccount" type="number" placeholder="e.g. 0123456789" style="
          width:100%;height:54px;border:2px solid #2A2825;border-radius:14px;
          padding:0 16px;font-size:15px;font-weight:600;color:#3B82F6;
          background:#FFFFFF;outline:none;box-sizing:border-box;
          font-family:'Inter',sans-serif;margin-bottom:24px;
        ">
        <button id="popupSubmitBtn" style="
          width:100%;height:56px;border:none;border-radius:14px;
          background:#3B82F6;color:#FFFFFF;font-size:16px;font-weight:700;
          cursor:pointer;font-family:'Inter',sans-serif;
        ">
          Submit & Await Confirmation
        </button>
        <button id="popupCancelBtn" style="
          width:100%;height:44px;border:none;border-radius:14px;
          background:transparent;color:#9CA3AF;font-size:14px;
          font-weight:500;cursor:pointer;margin-top:10px;
          font-family:'Inter',sans-serif;
        ">
          Cancel
        </button>
      </div>
    `;

    document.body.appendChild(overlay);
    setTimeout(() => document.getElementById("popupPayerName").focus(), 100);

    document
      .getElementById("popupCancelBtn")
      .addEventListener("click", () => closePayerForm(overlay));
    document
      .getElementById("popupSubmitBtn")
      .addEventListener("click", () => submitPayerDetails(overlay));
  }

  function closePayerForm(overlay) {
    payPage.style.filter = "";
    payPage.style.pointerEvents = "";
    overlay.remove();
  }

  // ── SUBMIT TO MONGO API ──────────────────────────────────────────
  async function submitPayerDetails(overlay) {
    const payerName = document.getElementById("popupPayerName").value.trim();
    const payerAccount = document
      .getElementById("popupPayerAccount")
      .value.trim();
    const amount =
      Number(document.getElementById("customAmount")?.value) || selectedAmt;
    const note = document.getElementById("payNote")?.innerText || "N/A";
    const user = auth?.currentUser;

    if (!payerName || !payerAccount) {
      document.getElementById("popupPayerName").style.borderColor = !payerName
        ? "#ef4444"
        : "#2A2825";
      document.getElementById("popupPayerAccount").style.borderColor =
        !payerAccount ? "#ef4444" : "#2A2825";
      return;
    }

    const submitBtn = document.getElementById("popupSubmitBtn");
    submitBtn.textContent = "Submitting...";
    submitBtn.disabled = true;
    submitBtn.style.opacity = "0.7";

    try {
      const userPhone = await _getPhone(user);

      // ── FETCH HISTORY (Look for 'success' status) ─────────────────
      const q = query(
        collection(transactionDb, "manualDeposits"),
        where("uid", "==", user.uid),
        where("status", "==", "success"),
      );
      const snap = await getDocs(q);

      // Sort successful deposits to find the earliest one
      const docs = snap.docs.map((d) => d.data());
      docs.sort(
        (a, b) => timestampMillis(a.timestamp) - timestampMillis(b.timestamp),
      );

      const firstDeposit = docs.length > 0 ? docs[0] : null;

      // ── DETERMINE BONUS TYPE ──────────────────────────────────
      const isFirst = !firstDeposit;
      const amountMatches =
        firstDeposit && Number(amount) === Number(firstDeposit.amount);

      const bonusAmt = 0;

      // ── SAVE TO MONGO API ─────────────────────────────────────
      await addDoc(collection(transactionDb, "manualDeposits"), {
        uid: user?.uid || "N/A",
        userEmail: user?.email || "N/A",
        userPhone: userPhone,
        amount: amount,
        payerName: payerName,
        payerAccount: payerAccount,
        referenceNote: note,
        status: "pending",
        method: "Manual Bank Transfer",
        timestamp: serverTimestamp(),
        dateString: new Date().toLocaleString(),
        isFirstDeposit: isFirst,
        isRematchDeposit: amountMatches,
        bonusAmount: bonusAmt,
        bonusApplied: false,
      });

      _bustDepositCache();
      closePayerForm(overlay);
      clearInterval(payTimerInterval);

      // ── SUCCESS POPUP ──────────────────────────────────────────
      let successHtml = `
      <div style="text-align:center;line-height:1.6;">
        <p style="margin:0;font-size:15px;color:#3B82F6;">
          ₦${Number(amount).toLocaleString()} deposit is pending review.
        </p>
    `;

      // Bonus display removed as per request

      successHtml += `
        <p style="margin-top:10px;color:#9CA3AF;font-size:13px;">
          Admin will verify and credit your account shortly.
        </p>
      </div>
    `;

      Swal.fire({
        icon: "success",
        title: "Submitted!",
        html: successHtml,
        background: "#FFFFFF",
        color: "#3B82F6",
        confirmButtonColor: "#3B82F6",
        confirmButtonText: "Back to Dashboard",
      }).then(() => {
        payPage.style.display = "none";
        if (dashboard) dashboard.style.display = "block";
        if (bottomNav) bottomNav.style.display = "flex";
      });
    } catch (error) {
      console.error("Deposit submission failed:", error);
      submitBtn.textContent = "Submit & Await Confirmation";
      submitBtn.disabled = false;
      submitBtn.style.opacity = "1";

      Swal.fire({
        icon: "error",
        title: "Submission Failed",
        text: "Something went wrong. Please try again.",
        background: "#FFFFFF",
        color: "#3B82F6",
        confirmButtonColor: "#3B82F6",
      });
    }
  }
});

const profilePage = document.getElementById("profilePage");

const bottomNavItems = document.querySelectorAll(".bottom-nav .nav-item");
// product page elements
const productPage = document.getElementById("productPage");
const productList = document.getElementById("productList");

// Add click event to all nav items
const pages = [
  document.getElementById("dashboard"),
  document.getElementById("profilePage"),
  document.getElementById("rechargePage"),
  document.getElementById("rechargeConfirmPage"), // include the recharge confirmation page
  document.getElementById("productPage"),
  document.getElementById("invitePage"), // <--- added here
  document.getElementById("teamPage"),
  document.getElementById("bankPage"),
  document.getElementById("withdrawPage"), // 👈 Add this
  document.getElementById("recordsPage"),
  document.getElementById("myInvestmentPage"),
  document.getElementById("earningsPage"),
  // add other pages here if you create more
];

bottomNavItems.forEach((item) => {
  item.addEventListener("click", function (e) {
    e.preventDefault();

    const text = item.textContent.trim().toLowerCase();

    let targetPage = null;
    if (text.includes("home")) targetPage = pages[0];
    if (text.includes("profile")) targetPage = pages[1];
    if (text.includes("reviews")) targetPage = pages[4]; // productPage
    if (text.includes("team")) targetPage = pages[6]; // View Team button fixes
    if (text.includes("invite")) targetPage = pages[5];
    if (text.includes("bank")) targetPage = pages[7];
    if (text.includes("withdraw")) targetPage = pages[8];
    if (text.includes("records")) targetPage = pages[9];
    if (text.includes("my investment")) targetPage = pages[10];
    if (text.includes("earnings")) targetPage = pages[11];

    if (!targetPage) return;

    const loader = document.getElementById("pageLoader");
    loader.style.display = "flex";
    loader.style.opacity = "1";

    setTimeout(() => {
      pages.forEach((page) => {
        if (page) page.style.display = "none";
      });

      if (targetPage.id === "invitePage") {
        targetPage.style.display = "flex";
        targetPage.style.flexDirection = "column";
      } else {
        targetPage.style.display = "block";
      }
      // 🚀 ADD THIS LINE HERE:
      localStorage.setItem("lastPage", targetPage.id);

      loader.style.opacity = "0";
      setTimeout(() => (loader.style.display = "none"), 500);
    }, 300);
  });
});

document.addEventListener("DOMContentLoaded", () => {
  const earningsPage = document.getElementById("earningsPage"); // Team page
  const earningsBackBtn = document.getElementById("earningsBackBtn"); // Back button inside team page
  const bottomNav = document.getElementById("bottomNav"); // Bottom nav
  const dashboard = document.getElementById("dashboard"); // Default page to return to

  const earningsBtn = document.getElementById("earningsBtn"); // Button to open team page
  if (earningsBtn) {
    earningsBtn.addEventListener("click", () => {
      // Hide all other pages safely
      if (pages && pages.length) {
        pages.forEach((p) => {
          if (p) p.style.display = "none";
        });
      }

      // Show Team page
      if (earningsPage) earningsPage.style.display = "block";

      // Hide bottom nav
      if (bottomNav) bottomNav.style.display = "none";
    });
  }

  // Back button click → return to dashboard/home
  if (earningsBackBtn) {
    earningsBackBtn.addEventListener("click", () => {
      if (earningsPage) earningsPage.style.display = "none";
      if (dashboard) dashboard.style.display = "block";
      if (bottomNav) bottomNav.style.display = "flex";
    });
  }
});

document.addEventListener("DOMContentLoaded", () => {
  const bottomNav = document.getElementById("bottomNav");
  const withdrawPage = document.getElementById("withdrawPage");
  const dashboard = document.getElementById("dashboard");
  const withdrawBackBtn = document.getElementById("withdrawBackBtn");

  const withdrawBtns = document.querySelectorAll(
    ".qa-btn.withdraw, #withdrawBtn",
  );

  withdrawBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      // Hide all pages safely
      if (pages && pages.length) {
        pages.forEach((p) => {
          if (p) p.style.display = "none";
        });
      }

      if (withdrawPage) withdrawPage.style.display = "block";
      if (bottomNav) bottomNav.style.display = "none";

      // Load withdraw data
      if (typeof loadWithdrawData === "function") loadWithdrawData();
    });
  });

  // Back button click
  if (withdrawBackBtn) {
    withdrawBackBtn.addEventListener("click", () => {
      withdrawPage.style.display = "none";
      dashboard.style.display = "block";
      bottomNav.style.display = "flex";
    });
  }
});

document.addEventListener("DOMContentLoaded", () => {
  const recordsPage = document.getElementById("recordsPage");
  const recordsBackBtn = document.getElementById("recordsBackBtn");
  const bottomNav = document.getElementById("bottomNav");
  const dashboard = document.getElementById("dashboard");

  const recordsBtn = document.getElementById("myRecordsBtn");
  if (recordsBtn) {
    recordsBtn.addEventListener("click", () => {
      // Hide all other pages safely
      if (pages && pages.length) {
        pages.forEach((p) => {
          if (p) p.style.display = "none";
        });
      }

      // Show Records page
      if (recordsPage) recordsPage.style.display = "block";

      // Hide bottom nav
      if (bottomNav) bottomNav.style.display = "none";

      // Load records
      const container = document.getElementById("recordsContainer");
      if (container) loadRecords(container);
    });
  }

  // Back button click → return to home/dashboard
  if (recordsBackBtn) {
    recordsBackBtn.addEventListener("click", () => {
      recordsPage.style.display = "none";
      dashboard.style.display = "block";
      bottomNav.style.display = "flex"; // show nav again
    });
  }
});

document.addEventListener("DOMContentLoaded", () => {
  const investmentPage = document.getElementById("myInvestmentPage");
  const investmentRecordsBtn = document.getElementById("investmentRecordsBtn");
  const bottomNav = document.getElementById("bottomNav");

  const dashboard = document.getElementById("dashboard");
  const investmentBackBtn = document.getElementById("investmentBackBtn");

  let countdownIntervals = [];

  // ================= BACK BUTTON =================
  if (investmentBackBtn) {
    investmentBackBtn.addEventListener("click", () => {
      investmentPage.style.display = "none";
      dashboard.style.display = "block";
      bottomNav.style.display = "flex";

      countdownIntervals.forEach(clearInterval);
      countdownIntervals = [];
    });
  }

  // ================= RENDER INVESTMENTS =================
  if (investmentRecordsBtn) {
    investmentRecordsBtn.addEventListener("click", async () => {
      // 1. Force Clean Page State
      investmentPage.style.display = "block";
      if (bottomNav) bottomNav.style.display = "block";

      const profilePage = document.getElementById("profilePage");
      if (profilePage) profilePage.style.display = "none";
      if (dashboard) dashboard.style.display = "none";

      // 2. Setup Container
      const container = document.getElementById("investment-list-container");
      if (!container) return;
      container.innerHTML = "";

      const user = auth?.currentUser;
      if (!user) return;

      const userSnap = await getDoc(doc(db, "users", user.uid));
      const rawData = userSnap.data()?.investments;

      // DEFENSIVE CONVERSION: Ensure it is always an Array
      const investments = Array.isArray(rawData)
        ? rawData
        : Object.values(rawData || {});

      // Now this will work safely
      investments.forEach((inv, index) => {
        const purchaseTime = inv.purchaseTime?.seconds
          ? inv.purchaseTime.seconds * 1000
          : Number(inv.purchaseTime);
        const incomePer3Hrs = Number(inv.daily) / 8;
        const incomePerDrop = Number(inv.daily) / 8;

        const card = document.createElement("div");
        card.className = "wave-investment-item";

        card.innerHTML = `
  <div class="market-wave-card">

    <div class="wave-header">
      <h3 class="wave-title">
        <span style="color: #FFFFFF; text-shadow: 0 0 10px rgba(255, 255, 255, 0.3);">VENTA</span> 
        <span style="color: #3B82F6; text-shadow: 0 0 12px rgba(188, 144, 79, 0.6);">WAVE</span>
      </h3>
      <p class="wave-subtitle">₦${Number(inv.price || 0).toLocaleString()} | AI POWERED | 24/7 INCOME GENERATION</p>
    </div>

    <div class="wave-visual-area">
      <svg class="wave-svg" viewBox="0 0 500 100" preserveAspectRatio="none">
        <path d="M0 50 Q 50 10, 100 50 T 200 50 T 300 50 T 400 50 T 500 50" fill="none" stroke="#93C5FD" stroke-width="2" />
      </svg>

      <div class="wave-markers-container">
        ${Array.from({ length: 8 })
          .map(
            (_, i) => `
          <div class="wave-marker" style="left: ${10 + i * 11.4}%">
            <div class="marker-dot"></div>
            <span class="marker-val">₦${incomePer3Hrs.toLocaleString()}</span>
          </div>
        `,
          )
          .join("")}
      </div>

      <div class="center-circle"><div class="work-val">24/7</div></div>
    </div>

    <div class="status-bar">
      <span>Status: <b style="color: #4ade80;">Active</b></span>
      <span>Next Drop: <b id="cd-${index}">00:00:00</b></span>
    </div>

    <div class="profit-footer">
      <div class="total-box">
        <p>Current Profit</p>
        <h2 class="total-val" id="val-${index}">₦0.00</h2>
      </div>
      <button id="actionBtn-${index}" class="take-profit-btn" disabled>Earning...</button>
    </div>

    <p class="hint">Profit will be automatically credited to your balance every 24 hours.</p>

  </div>
`;

        container.appendChild(card);

        // ===== LOGIC (Automated) =====
        // No manual actions needed. System handles auto-claiming every 24 hours.
      });
    });
  }
}); // <--- THIS WAS THE MISSING BRACKET

const FintechToast = Swal.mixin({
  toast: true,
  position: "top-end",
  showConfirmButton: false,
  timer: 3000,
  timerProgressBar: true,
  background: "#fff",
  color: "#111",
  customClass: {
    popup: "fintech-toast",
  },
});

async function handleInvestment(amount, daily, days, name) {
  const user = auth.currentUser;
  if (!user) {
    window.showToast("Not Logged In: Please log in first!", "error");
    return;
  }

  const productName = name || "Investment";

  try {
    const result = await walletRequest("buyInvestment", {
      name: productName,
      price: Number(amount),
      daily: Number(daily),
      cycle: Number(days),
    });
    userInvestmentsLocal = [...userInvestmentsLocal, result.investment];

    // payReferralCommission(user.uid, amount, days); // Disabled to prevent double commission payout (Auto-Claim handles this)
    window.showToast("Investment Successful!", "success");
    showDashboard();
  } catch (err) {
    console.error("Investment Error:", err);
    window.showToast("Transaction failed. Please try again.", "error");
  }
}

// ======================================================
// SYNC EARNINGS (UPDATED FOR 24H CYCLE)
// ======================================================
async function syncEarnings(userId) {
  if (!userId || isSyncingNow) return;
  isSyncingNow = true;

  try {
    const result = await walletRequest("syncEarnings");
    userInvestmentsLocal = Array.isArray(result.investments)
      ? result.investments
      : [];
    if (result.credited > 0)
      console.log(`Auto-claimed ₦${result.credited} for user ${userId}`);
  } catch (error) {
    console.error("Sync Earnings Error:", error);
  } finally {
    isSyncingNow = false;
  }
}

// ======================================================
// GLOBALS & CONFIG
// ======================================================
let userInvestmentsLocal = [];
let investmentInterval = null;

// ======================================================
// 1. START SYSTEM (RUNS ONCE ON LOGIN)
// ======================================================
async function startInvestmentSystem(userId, initialData = null) {
  try {
    // 1. Clean up previous sessions
    if (investmentInterval) clearInterval(investmentInterval);

    // 2. Sync earnings state
    await syncEarnings(userId);

    // 3. Get data: Use initialData if passed from Google Login, otherwise fetch from DB
    let data;
    if (initialData) {
      data = initialData;
    } else {
      const userRef = doc(db, "users", userId);
      const snap = await getDoc(userRef);
      data = snap.exists() ? snap.data() : null;
    }

    if (data) {
      // DEFENSIVE CONVERSION:
      const rawInvestments = data.investments;

      if (Array.isArray(rawInvestments)) {
        userInvestmentsLocal = rawInvestments;
      } else if (rawInvestments && typeof rawInvestments === "object") {
        userInvestmentsLocal = Object.values(rawInvestments);
      } else {
        userInvestmentsLocal = [];
      }

      console.log(
        "Investments initialized successfully:",
        userInvestmentsLocal,
      );
    } else {
      console.warn("User document not found.");
      userInvestmentsLocal = [];
    }

    // 4. Start the UI timer
    investmentInterval = setInterval(() => {
      renderCountdowns(userInvestmentsLocal);
    }, 1000);
  } catch (error) {
    console.error("Critical error in startInvestmentSystem:", error);
  }
}

// ======================================================
// 2. COUNTDOWN UI (24H CYCLE LOGIC) - UNIFIED
// ======================================================
function renderCountdowns(investments) {
  if (!Array.isArray(investments) || investments.length === 0) return;

  const now = Date.now();
  const MS_IN_DAY = 86400000;
  const THREE_HOURS = 3 * 60 * 60 * 1000;

  investments.forEach((inv, i) => {
    const cdEl = document.getElementById(`cd-${i}`);
    const valEl = document.getElementById(`val-${i}`); // Total Profit display
    const btn = document.getElementById(`actionBtn-${i}`); // Claim/Sell button

    if (!cdEl) return;

    // --- 1. TIME LOGIC ---
    const rawTime = inv.purchaseTime?.seconds
      ? inv.purchaseTime.seconds * 1000
      : Number(inv.purchaseTime);
    const purchaseTime = isNaN(rawTime) ? now : rawTime;
    const elapsed = now - purchaseTime;
    const remaining = Math.max(0, MS_IN_DAY - elapsed);

    // --- 2. PROFIT CALCULATION ---
    // Calculate how many 3-hour drops (10,800,000ms) have occurred
    const drops = Math.floor(elapsed / THREE_HOURS);
    const incomePerDrop = Number(inv.daily) / 8;
    // Calculate earnings, capped so it doesn't exceed daily total
    const newEarned = Math.min(drops * incomePerDrop, Number(inv.daily));

    if (valEl) {
      valEl.textContent = `₦${newEarned.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
    }

    // --- 3. TIMER TEXT ---
    let newText = "";
    if (remaining <= 0) {
      newText = "Auto-claiming...";
      // Trigger sync if not already syncing
      if (!isSyncingNow) {
        syncEarnings(auth.currentUser.uid);
      }
    } else {
      const h = Math.floor(remaining / 3600000);
      const m = Math.floor((remaining % 3600000) / 60000);
      const s = Math.floor((remaining % 60000) / 1000);
      newText = `${h}h ${m}m ${s}s`;
    }
    if (cdEl.textContent !== newText) cdEl.textContent = newText;

    // --- 4. BUTTON LOGIC ---
    if (btn) {
      if (remaining <= 0) {
        btn.disabled = true;
        btn.textContent = "Auto-claiming...";
      } else {
        btn.disabled = true;
        btn.textContent = "Earning...";
      }
    }
  });
}

// ======================================================
// 3. AUTO-START (ON LOGIN)
// ======================================================
onAuthStateChanged(auth, (user) => {
  if (user) {
    startInvestmentSystem(user.uid);
  } else {
    // Clear everything on logout
    if (investmentInterval) clearInterval(investmentInterval);
    userInvestmentsLocal = [];
  }
});

// ======================================================
// INVEST BUTTON HANDLER (OPTIMIZED)
// ======================================================
document.addEventListener("DOMContentLoaded", () => {
  const productContainer = document.querySelector(".dashboard .product-list");
  if (!productContainer) return;

  productContainer.addEventListener("click", async (e) => {
    const btn = e.target.closest(".invest-btn");
    if (!btn) return;

    // 1. Prevent multiple clicks immediately
    if (btn.dataset.processing === "true") return;

    const card = btn.closest(".product-card");
    if (!card) return;

    let price = 0,
      daily = 0,
      days = 0;

    // Helper to clean currency/strings
    const cleanNum = (str) => parseInt(str.replace(/[^0-9]/g, ""), 10) || 0;

    // Extract values
    card.querySelectorAll(".info-row").forEach((row) => {
      const label =
        row.querySelector(".info-label")?.innerText.toLowerCase() || "";
      const value = row.querySelector(".info-value")?.innerText || "";

      if (label.includes("price")) price = cleanNum(value);
      if (label.includes("daily")) daily = cleanNum(value);
      if (label.includes("period")) days = cleanNum(value);
    });

    if (!price || !daily || !days) {
      window.showToast(
        "Error: Could not retrieve valid investment details.",
        "error",
      );
      return;
    }

    // 2. Set processing state
    btn.dataset.processing = "true";
    const originalText = btn.innerText;
    btn.innerText = "Processing...";
    btn.style.opacity = "0.7";
    btn.style.cursor = "not-allowed";

    // 3. Trigger loader and execute investment
    try {
      await showLoader({
        callback: async () => {
          await handleInvestment(price, daily, days);
        },
      });
    } catch (error) {
      console.error("Investment process error:", error);
    } finally {
      // 4. Reset button state
      btn.dataset.processing = "false";
      btn.innerText = originalText;
      btn.style.opacity = "1";
      btn.style.cursor = "pointer";
    }
  });
});

// Expose to window for external access
window.handleInvestment = handleInvestment;

document.addEventListener("DOMContentLoaded", () => {
  const welcomePopup = document.getElementById("welcomePopup");
  const closePopup = document.getElementById("closePopup");
  const bottomNav = document.getElementById("bottomNav");

  /* HIDE POPUP + SHOW NAV */
  closePopup.addEventListener("click", () => {
    welcomePopup.style.display = "none";
    bottomNav.classList.add("open");
  });
});

function openInvitePage() {
  // hide ALL pages first
  pages.forEach((page) => {
    if (page) page.style.display = "none";
  });

  // show invite page properly
  invitePage.style.display = "flex";
  invitePage.style.flexDirection = "column";

  // hide bottom nav if needed
  bottomNav.style.display = "none";

  // load referral data
  const user = auth.currentUser;
  if (user) setupReferral(user);
}

document.addEventListener("DOMContentLoaded", () => {
  const bottomNav = document.getElementById("bottomNav");
  const invitePage = document.getElementById("invitePage");
  const teamPage = document.getElementById("teamPage");
  const dashboard = document.getElementById("dashboard");
  const inviteBackBtn = document.getElementById("inviteBackBtn");
  const bottomNavItems = document.querySelectorAll(".nav-item");
  const viewTeamButtons = document.querySelectorAll(".team-btn");
  const refCardBtn = document.getElementById("refCard"); // Invite button

  // ------------------ Disable "View Team" buttons on Invite Page ------------------
  viewTeamButtons.forEach((btn) => (btn.disabled = true));

  // ------------------ Bottom Nav Clicks ------------------
  bottomNavItems.forEach((item) => {
    item.addEventListener("click", function () {
      const text = item.textContent.trim().toLowerCase();

      // Hide all pages first
      [dashboard, invitePage, teamPage].forEach((p) => {
        if (p) p.style.display = "none";
      });

      if (text === "home") {
        dashboard.style.display = "block";
        bottomNav.style.display = "flex";
      }

      if (text.includes("invite")) {
        openInvitePage();
        return;
      }

      if (text === "team") {
        teamPage.style.display = "block";
        invitePage.style.display = "none";
        bottomNav.style.display = "none";
        openTeam(1); // Load Level 1 by default
      }
    });
  });

  // ------------------ Invite Button (refCard) Click ------------------
  if (refCardBtn) {
    refCardBtn.addEventListener("click", (e) => {
      e.preventDefault();
      openInvitePage();
    });
  }

  // ------------------ Share Button (shareBtn) Click ------------------
  const shareBtn = document.getElementById("shareBtn");

  if (shareBtn) {
    shareBtn.addEventListener("click", (e) => {
      e.preventDefault();
      openInvitePage();
    });
  }

  const myTeamBtn = document.getElementById("myTeamBtn");

  if (myTeamBtn) {
    myTeamBtn.addEventListener("click", (e) => {
      e.preventDefault();

      // Hide all pages in the pages array
      pages.forEach((p) => {
        if (p) p.style.display = "none";
      });

      // Hide bottom nav
      if (bottomNav) bottomNav.style.display = "flex";

      // Show the invite/referral page
      if (invitePage) {
        invitePage.style.display = "flex";
        invitePage.style.flexDirection = "column";
        invitePage.style.width = "100%";
      }

      // Setup referral
      const user = auth.currentUser;
      if (user) setupReferral(user);
    });
  }

  // ------------------ Invite Back Button ------------------
  if (inviteBackBtn) {
    inviteBackBtn.addEventListener("click", () => {
      invitePage.style.display = "none";
      dashboard.style.display = "block";
      bottomNav.style.display = "flex";
    });
  }
});

function copyInviteLink() {
  const refInput = document.getElementById("refLink");
  if (!refInput) return;

  // Select and copy the value
  refInput.select();
  refInput.setSelectionRange(0, 99999); // for mobile

  // Use execCommand for compatibility
  document.execCommand("copy");

  window.showToast("Copied: Referral link copied to clipboard!", "success");
}
window.copyInviteLink = copyInviteLink;

// ------------------ Copy Invite Code ------------------
function copyInviteCode() {
  const codeText = document.getElementById("inviteCode");
  if (!codeText) return;

  const temp = document.createElement("textarea");
  temp.value = codeText.textContent;
  document.body.appendChild(temp);
  temp.select();
  document.execCommand("copy");
  document.body.removeChild(temp);

  window.showToast("Invite code copied successfully!", "success");
}
window.copyInviteCode = copyInviteCode;

// ------------------ Setup Referral ------------------
async function setupReferral(user) {
  if (!user) return;
  const referralId = user.referralId;
  if (!referralId) return;

  // Show short invite code
  const inviteCodeBox = document.getElementById("inviteCode");
  if (inviteCodeBox) {
    inviteCodeBox.textContent = referralId;
  }

  // Set full referral link
  const refInput = document.getElementById("refLink");
  if (refInput) {
    refInput.value = `${window.location.origin}${window.location.pathname}#?ref=${referralId}`;
  }
}

// ------------------ Generate Referral ID ------------------
function generateReferralId() {
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const numbers = "0123456789";

  const part1 = Array.from(
    { length: 3 },
    () => letters[Math.floor(Math.random() * letters.length)],
  ).join("");

  const part2 = Array.from(
    { length: 3 },
    () => numbers[Math.floor(Math.random() * numbers.length)],
  ).join("");

  return part1 + part2;
}

const referralLink = document.getElementById("refLink");

document.querySelectorAll(".share-btn").forEach((btn) => {
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    const link = referralLink.value;
    let url = "#";

    if (btn.classList.contains("facebook"))
      url = `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(link)}`;
    if (btn.classList.contains("twitter"))
      url = `https://twitter.com/intent/tweet?url=${encodeURIComponent(link)}`;
    if (btn.classList.contains("whatsapp"))
      url = `https://api.whatsapp.com/send?text=${encodeURIComponent(link)}`;
    if (btn.classList.contains("telegram"))
      url = `https://t.me/share/url?url=${encodeURIComponent(link)}`;

    window.open(url, "_blank");
  });
});

document.addEventListener("DOMContentLoaded", () => {
  // Handle opening the Team Page
  document.getElementById("viewTeamBtn")?.addEventListener("click", () => {
    // 1. Show the Team Page (assuming you have a function or style change here)
    const teamPage = document.getElementById("teamPage"); // Use your actual ID
    if (teamPage) teamPage.style.display = "block";

    // 2. Set the Level 1 tab to active visually
    const l1Btn = document.getElementById("level1Btn");
    if (l1Btn) setActiveTab(l1Btn);

    // 3. Trigger the data load
    loadTeam(1);

    // 4. Hide nav
    const nav = document.getElementById("bottomNav");
    if (nav) nav.style.display = "none";
  });
});

// ======================================================
// AUTO CLAIM COMMISSION (DYNAMIC & DUAL-DB OPTIMIZED)
// ======================================================

async function startAutoClaim() {
  if (autoClaimStarted) return;
  autoClaimStarted = true;

  const user = auth.currentUser;
  if (!user) return;
  const check = async () => {
    try {
      const result = await walletRequest("autoClaimCommissions");
      if (result.balanceIncrease > 0) {
        console.log(
          `Claimed ₦${result.balanceIncrease} in referral commissions.`,
        );
      }
    } catch (error) {
      console.error("Referral commission check failed:", error);
    }
  };
  await check();
  autoClaimTimer = setInterval(check, 60_000);
}

// 🛡️ AUTH WATCHER: Ensures the system starts when the user logs in
auth.onAuthStateChanged((user) => {
  if (user) {
    console.log("Auto-Claim System: INITIALIZING...");
    startAutoClaim();
  } else {
    autoClaimStarted = false;
    if (autoClaimTimer) clearInterval(autoClaimTimer);
    autoClaimTimer = null;
  }
});

// Global memory cache preserved exactly
let cachedUserData = null;
let cachedGlobalRates = null;

// ======================================================
// DYNAMIC NAVIGATION PILL TOGGLE ENGINE
// ======================================================
function showLevelDetails(level) {
  // Update state active focus classes on pills to mirror exact UI wireframes
  const tabL1 = document.getElementById("tabToggleLevel1");
  const tabL2 = document.getElementById("tabToggleLevel2");

  if (level === 1) {
    if (tabL1) tabL1.classList.add("state-active");
    if (tabL2) tabL2.classList.remove("state-active");
  } else {
    if (tabL1) tabL1.classList.remove("state-active");
    if (tabL2) tabL2.classList.add("state-active");
  }

  // Force content viewport container framework online
  const detailView = document.getElementById("detailView");
  const listTitle = document.getElementById("listTitle");
  if (detailView) detailView.style.display = "block";
  if (listTitle) listTitle.textContent = `Tier ${level} Members`;

  loadTeam(level);
}

function closeDetails() {
  // Gracefully clear view interface without damaging backend references
  const detailView = document.getElementById("detailView");
  if (detailView) detailView.style.display = "block"; // Keep visibility context open but reset to clear state
  resetToEmptyPlaceholder(1);
}

function resetToEmptyPlaceholder(level) {
  const teamListEl = document.getElementById("teamList");
  if (!teamListEl) return;
  teamListEl.innerHTML = `
    <div class="empty-state-vector-wrapper">
      <div class="empty-vector-network-icon">
        <i class="fa-solid fa-share-nodes"></i>
      </div>
      <p class="empty-state-main-prompt">No Level ${level} referrals yet</p>
      <a href="javascript:void(0);" class="referral-trigger-action-link" onclick="copyReferralTrigger()">Share your referral link to start earning!</a>
    </div>
  `;
}

function copyReferralTrigger() {
  const codeString = document.getElementById("userReferralCodeDisplay");
  if (codeString) {
    navigator.clipboard.writeText(codeString.innerText);
    alert("Referral link parameters captured safely to clip!");
  }
}

// ======================================================
// LOAD SUMMARY CARDS (Optimized Quota Parallel Reads)
// ======================================================
async function loadSummary() {
  const user = auth.currentUser;
  if (!user) return;

  try {
    // 1. Fetch Admin Rates and User Document in Parallel
    const [ratesSnap, userSnap] = await Promise.all([
      getDoc(doc(db, "adminSettings", "rates")),
      getDoc(doc(db, "users", user.uid)),
    ]);

    cachedGlobalRates = ratesSnap.exists()
      ? ratesSnap.data()
      : { level1: 0.25, level2: 0.03 };

    if (!userSnap.exists()) return;
    cachedUserData = userSnap.data();

    let combinedTeamSize = 0;
    let combinedTeamRecharge = 0;

    // Update Percentage Labels safely mapping into core notice block descriptions
    if (document.getElementById("t1CommPercentDisplay")) {
      document.getElementById("t1CommPercentDisplay").textContent =
        `${Math.round(cachedGlobalRates.level1 * 100)}%`;
    }
    if (document.getElementById("t2CommPercentDisplay")) {
      document.getElementById("t2CommPercentDisplay").textContent =
        `${Math.round(cachedGlobalRates.level2 * 100)}%`;
    }

    let level1CalculatedComm = "₦0";
    let level2CalculatedComm = "₦0";
    let l1CountValue = 0;
    let l2CountValue = 0;

    // 2. Loop Tiers and execute optimized batch fetches
    for (const level of [1, 2]) {
      const referrals =
        level === 1
          ? cachedUserData.referrals?.level1 || []
          : cachedUserData.referrals?.level2 || [];

      combinedTeamSize += referrals.length;
      if (level === 1) l1CountValue = referrals.length;
      if (level === 2) l2CountValue = referrals.length;

      const commRate =
        level === 1 ? cachedGlobalRates.level1 : cachedGlobalRates.level2;
      let totalInvest = 0;

      // Parallel execution mapping
      if (referrals.length > 0) {
        const fetchPromises = referrals.map((ref) =>
          getDoc(doc(db, "users", ref.uid)),
        );
        const snapResults = await Promise.all(fetchPromises);

        snapResults.forEach((refSnap) => {
          if (refSnap.exists()) {
            const investments = refSnap.data().investments || [];
            investments.forEach((inv) => {
              totalInvest += Number(inv.price || 0);
            });
          }
        });
      }

      combinedTeamRecharge += totalInvest;
      const totalComm = totalInvest * commRate;

      // Cache string values to safely feed into the 6pack elements
      if (level === 1) level1CalculatedComm = `₦${totalComm.toLocaleString()}`;
      if (level === 2) level2CalculatedComm = `₦${totalComm.toLocaleString()}`;

      // Update structural element fallback caches safely
      if (document.getElementById(`t${level}Count`)) {
        document.getElementById(`t${level}Count`).textContent =
          referrals.length;
      }
      if (document.getElementById(`t${level}Comm`)) {
        document.getElementById(`t${level}Comm`).textContent =
          `₦${totalComm.toLocaleString()}`;
      }
    }

    // Update Interactive Button Tab Counter Text Metrics dynamically to mirror replica designs
    const tabL1 = document.getElementById("tabToggleLevel1");
    const tabL2 = document.getElementById("tabToggleLevel2");
    if (tabL1) tabL1.textContent = `Level 1 (${l1CountValue})`;
    if (tabL2) tabL2.textContent = `Level 2 (${l2CountValue})`;

    // Inject matching data strings directly inside multi-metric targets
    if (document.getElementById("sixpackL1Comm")) {
      document.getElementById("sixpackL1Comm").textContent =
        level1CalculatedComm;
    }
    if (document.getElementById("sixpackL2Comm")) {
      document.getElementById("sixpackL2Comm").textContent =
        level2CalculatedComm;
    }
    if (document.getElementById("sixpackL1Rate")) {
      document.getElementById("sixpackL1Rate").textContent =
        `${Math.round(cachedGlobalRates.level1 * 100)}%`;
    }
    if (document.getElementById("sixpackL2Rate")) {
      document.getElementById("sixpackL2Rate").textContent =
        `${Math.round(cachedGlobalRates.level2 * 100)}%`;
    }

    // Global Top Widgets Sync
    if (document.getElementById("globalTeamSizeSum")) {
      document.getElementById("globalTeamSizeSum").textContent =
        combinedTeamSize;
    }
    if (document.getElementById("globalTeamRechargeSum")) {
      document.getElementById("globalTeamRechargeSum").textContent =
        `₦${combinedTeamRecharge.toLocaleString()}`;
    }
  } catch (err) {
    console.error("Summary Load Error:", err);
  }
}

// ======================================================
// LOAD TEAM LIST (Zero Extra Profile Reads Optimization)
// ======================================================
async function loadTeam(level) {
  const teamListEl = document.getElementById("teamList");
  if (!teamListEl) return;

  teamListEl.innerHTML = `<p style="text-align:center; color:var(--gold-primary); font-size:13px; margin-top:20px;">Fetching Tier ${level} data...</p>`;

  try {
    if (!cachedUserData || !cachedGlobalRates) {
      const user = auth.currentUser;
      if (!user) return;
      const [ratesSnap, userSnap] = await Promise.all([
        getDoc(doc(db, "adminSettings", "rates")),
        getDoc(doc(db, "users", user.uid)),
      ]);
      cachedGlobalRates = ratesSnap.exists()
        ? ratesSnap.data()
        : { level1: 0.25, level2: 0.03 };
      if (!userSnap.exists()) return;
      cachedUserData = userSnap.data();
    }

    const referrals =
      level === 1
        ? cachedUserData.referrals?.level1 || []
        : cachedUserData.referrals?.level2 || [];

    if (referrals.length === 0) {
      resetToEmptyPlaceholder(level);
      return;
    }

    teamListEl.innerHTML = "";
    const commPercent =
      level === 1
        ? cachedGlobalRates.level1 * 100
        : cachedGlobalRates.level2 * 100;

    const fetchPromises = referrals.map((ref) =>
      getDoc(doc(db, "users", ref.uid)),
    );
    const snapResults = await Promise.all(fetchPromises);

    const fragment = document.createDocumentFragment();

    snapResults.forEach((refSnap, index) => {
      if (!refSnap.exists()) return;

      const d = refSnap.data();
      const investments = d.investments || [];
      let totalInvestmentValue = 0;
      investments.forEach((inv) => {
        totalInvestmentValue += Number(inv.price || 0);
      });

      const rawNum = d.number || "N/A";
      const maskedNum =
        rawNum.length > 7
          ? rawNum.substring(0, 4) + "****" + rawNum.slice(-3)
          : rawNum;

      const refMeta = referrals[index];
      const joinDate =
        refMeta && refMeta.createdAt
          ? new Date(refMeta.createdAt.seconds * 1000).toLocaleDateString(
              undefined,
              { month: "short", day: "numeric" },
            )
          : "N/A";

      const row = document.createElement("div");
      row.className = "tier-card";
      row.innerHTML = `
        <div class="tier-header">
            <div class="tier-title">
                <i class="fa-solid fa-user" style="color:var(--gold-primary);"></i>
                <span>User: ${maskedNum}</span>
            </div>
            <div class="tier-badge">Tier ${level}</div>
        </div>
        <div class="inner-user-grid-display">
            <div class="inner-user-box">
                <div class="inner-user-value">${joinDate}</div>
                <div class="inner-user-label">Joined</div>
            </div>
            <div class="inner-user-box">
                <div class="inner-user-value">₦${totalInvestmentValue.toLocaleString()}</div>
                <div class="inner-user-label">Investment</div>
            </div>
            <div class="inner-user-box">
                <div class="inner-user-value">${commPercent}%</div>
                <div class="inner-user-label">Commission</div>
            </div>
        </div>
      `;
      fragment.appendChild(row);
    });

    teamListEl.appendChild(fragment);
  } catch (err) {
    console.error("Team Load Error:", err);
    teamListEl.innerHTML = `<p style="text-align:center; color:#f43f5e; font-size:13px;">Failed to load team list framework.</p>`;
  }
}

// Auth State Triggers Hook
auth.onAuthStateChanged((user) => {
  if (user) {
    loadSummary();
  }
});

window.showLevelDetails = showLevelDetails;
window.closeDetails = closeDetails;
window.copyReferralTrigger = copyReferralTrigger;

// Ensure ALL operational layout triggers are globally visible to inline elements
window.loadSummary = loadSummary;

// Run only when user is logged in
onAuthStateChanged(auth, (user) => {
  if (!user) return; // not logged in, skip

  // Single reference to admin settings
  const settingsRef = doc(db, "adminSettings", "settings");

  // Real-time listener
  onSnapshot(settingsRef, (snapshot) => {
    if (!snapshot.exists()) return;
    const data = snapshot.data();

    // Telegram group button
    const tgBtn = document.querySelector(".join-tg-btn");
    if (tgBtn && data.officialGroup) {
      tgBtn.href = data.officialGroup;
    }

    // Customer service username
    const csBtn = document.getElementById("customerServiceBtn");
    if (csBtn && data.customerService) {
      csBtn.onclick = () => {
        const username = data.customerService.replace("@", "");
        window.open(`https://t.me/${username}`, "_blank");
      };
    }

    // Official group button click
    const officialDiv = document.querySelector(".official-group-link");
    if (officialDiv) {
      officialDiv.onclick = (e) => {
        e.stopPropagation(); // Prevent this click from triggering parent click listeners
        if (data?.officialGroup) {
          window.open(data.officialGroup, "_blank");
        } else {
          Toast.fire({
            icon: "error",
            title: "Link Unavailable",
            text: "Official group link not available.",
            confirmButtonColor: "#007bff",
          });
        }
      };
    }

    // --- Bank info section removed because it's not needed anymore ---
    // const bank = data.bankAccount;
    // if (bank) { ... }
  }); // End onSnapshot
}); // End onAuthStateChanged

// ── CACHE ────────────────────────────────────────────────────────────
const _wCache = {};

async function _getSettings() {
  if (_wCache.settings) return _wCache.settings;
  const snap = await getDoc(doc(db, "adminSettings", "settings"));
  _wCache.settings = snap.exists() ? snap.data() : {};
  return _wCache.settings;
}

async function _getUserData(uid) {
  if (_wCache.user) return _wCache.user;
  const snap = await getDoc(doc(db, "users", uid));
  _wCache.user = snap.exists() ? snap.data() : null;
  return _wCache.user;
}

function _bustUserCache() {
  delete _wCache.user; // force fresh read next time
}

// ── LOAD WITHDRAW PAGE ───────────────────────────────────────────────
async function loadWithdrawData() {
  if (!auth.currentUser) return;

  try {
    const [settings, userData] = await Promise.all([
      _getSettings(),
      _getUserData(auth.currentUser.uid),
    ]);

    if (!userData) return;

    const minWithdrawal = settings.minimumWithdrawal || 1000;
    window.MIN_WITHDRAWAL = minWithdrawal;

    // Balance
    const balEl = document.getElementById("withdrawBalance");
    if (balEl)
      balEl.textContent = "₦" + (userData.balance || 0).toLocaleString();

    // Bank card
    const bankCard = document.getElementById("withdrawBankCard");
    if (!bankCard) return;

    const bank = userData.bankAccount;

    if (bank) {
      const bankDropdown = document.getElementById("bankName");
      let bankLabel = bank.bankName;
      if (bankDropdown) {
        const match = Array.from(bankDropdown.options).find(
          (o) => o.value === bank.bankName,
        );
        if (match) bankLabel = match.text;
      }

      bankCard.innerHTML = `
        <p id="withdrawBankName">Bank: ${bankLabel}</p>
        <p id="withdrawAccountName">Name: ${bank.accountName}</p>
        <p id="withdrawAccountNumber">Acct No: ${bank.accountNumber.slice(0, 4)} **** ${bank.accountNumber.slice(-4)}</p>
      `;
    } else {
      bankCard.innerHTML = `
        <div class="bank-empty">
          <div class="bank-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"
              stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 21h18M3 10h18M5 10v11M19 10v11M6.5 6.5l5.5-3.5 5.5 3.5M12 3v7"/>
            </svg>
          </div>
          <h4>No Bank Account Linked</h4>
          <p>Secure your earnings by linking a primary withdrawal account.</p>
          <button id="addAccountBtn">Add Bank Account</button>
        </div>
      `;
    }
  } catch (err) {
    console.error("loadWithdrawData error:", err);
  }
}

// ── SUBMIT WITHDRAWAL ────────────────────────────────────────────────
document.getElementById("withdrawSubmitBtn").onclick = async () => {
  if (!auth.currentUser) return;

  const amountInput = document.getElementById("withdrawAmountInput");
  const submitBtn = document.getElementById("withdrawSubmitBtn");

  // ── VALIDATIONS (use cache — zero extra reads) ───────────────────
  const [settings, userData] = await Promise.all([
    _getSettings(),
    _getUserData(auth.currentUser.uid),
  ]);

  if (!userData) return;

  const bank = userData.bankAccount;

  if (!bank?.accountNumber || !bank?.bankName || !bank?.accountName) {
    window.showToast(
      "Bank Account Required: Please bind your bank account first!",
      "warning",
    );
    return;
  }

  const investments = Array.isArray(userData.investments)
    ? userData.investments
    : [];
  if (!investments.some((inv) => inv.status === "active")) {
    window.showToast(
      "No Active Investment: You must have at least one active investment to withdraw.",
      "warning",
    );
    return;
  }

  if (settings.withdrawalEnabled === false) {
    window.showToast(
      "Withdrawals Disabled: Withdrawals are currently disabled.",
      "warning",
    );
    return;
  }

  if (userData.withdrawalLocked) {
    window.showToast(
      "Restricted: Your account is restricted from withdrawal.",
      "error",
    );
    return;
  }

  if (userData.hasPendingWithdrawal === true) {
    window.showToast(
      "Pending Request: You already have a pending withdrawal.",
      "warning",
    );
    return;
  }

  const amount = parseFloat(amountInput.value);
  const minWithdrawal = settings.minimumWithdrawal || 1000;
  const currentBalance = userData.balance || 0;

  if (!amount || amount <= 0) {
    window.showToast("Invalid Amount: Enter a valid amount!", "warning");
    return;
  }
  if (amount < minWithdrawal) {
    window.showToast(
      `Amount Too Low: Minimum is ₦${minWithdrawal.toLocaleString()}`,
      "warning",
    );
    return;
  }
  if (amount > currentBalance) {
    window.showToast(
      "Insufficient Balance: You do not have enough funds!",
      "error",
    );
    return;
  }

  // ── PROCESSING ───────────────────────────────────────────────────
  submitBtn.innerText = "Processing...";
  submitBtn.disabled = true;

  try {
    const feeRate = settings.withdrawalFee ?? 0.15;
    const fee = amount * feeRate;
    const finalAmt = amount - fee;

    if (finalAmt < 510) {
      window.showToast(
        "Amount Too Low: Minimum payout after fees must be at least ₦510.",
        "warning",
      );
      return;
    }

    const result = await walletRequest("createWithdrawal", { amount });

    // Bust cache so balance reflects immediately on next load
    _bustUserCache();

    // Update balance on screen instantly
    const newBal = result.balance;
    const balEl = document.getElementById("withdrawBalance");
    if (balEl) balEl.textContent = "₦" + newBal.toLocaleString();
    amountInput.value = "";

    window.showToast(
      "Submitted! Your withdrawal request is pending admin approval.",
      "success",
    );
  } catch (err) {
    console.error("Withdrawal error:", err);
    window.showToast(
      "Failed: Transaction processing error. Please try again.",
      "error",
    );
  } finally {
    submitBtn.innerText = "Withdraw Funds";
    submitBtn.disabled = false;
  }
};

const recordsPage = document.getElementById("recordsPage");

if (recordsPage) {
  const filterBtns = recordsPage.querySelectorAll(".filter-btn");

  filterBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      // active state only inside records page
      filterBtns.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");

      const type = btn.dataset.type.toLowerCase();

      const cards = recordsPage.querySelectorAll(".record-card");

      cards.forEach((card) => {
        const text =
          card.querySelector(".record-transaction")?.innerText.toLowerCase() ||
          "";

        if (type === "all") {
          card.style.display = "flex";
        } else {
          card.style.display = text.includes(type) ? "flex" : "none";
        }
      });
    });
  });
}

// Helper to match the icon and style
function getIconConfig(type = "") {
  const t = type.toLowerCase();
  if (t.includes("withdrawal")) {
    return { icon: "fa-arrow-down", class: "icon-withdrawal" };
  }
  return { icon: "fa-wallet", class: "icon-deposit" };
}

// Helper for date formatting matching layout profile style: "28/05/2026"
function formatRecordDate(date) {
  if (!date) return "-";
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = date.getFullYear();
  return `${day}/${month}/${year}`;
}
async function loadRecords(container) {
  if (!container) return;
  container.innerHTML = "";

  const user = auth.currentUser;
  if (!user) return;

  let globalTrxCounter = 0;
  const totalTrxCountEl = document.getElementById("totalTrxCount");

  const collections = [
    { name: "withdrawals", label: "Withdrawal", database: coreNextDb },
    { name: "deposits", label: "Deposit", database: transactionDb },
    { name: "manualDeposits", label: "Deposit", database: transactionDb },
    { name: "records", label: "Commission", database: transactionDb },
  ];

  collections.forEach(({ name, label, database }) => {
    let colRef;

    if (name === "records") {
      colRef = collection(db, "users", user.uid, "records");
    } else {
      colRef = query(collection(database, name), where("uid", "==", user.uid));
    }

    onSnapshot(colRef, (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type !== "added") return;

        const rowId = `${name}-${change.doc.id}`;
        if (document.getElementById(rowId)) return;

        const data = change.doc.data();
        const amount =
          name === "withdrawals"
            ? (data.originalAmount ?? data.amount ?? 0)
            : (data.amount ?? 0);

        // ── DATE ──────────────────────────────────────────────────
        let dateObj = data.approvedAt || data.createdAt || data.timestamp;
        if (dateObj?.toDate) dateObj = dateObj.toDate();
        else if (dateObj) dateObj = new Date(dateObj);
        const formattedDate = formatRecordDate(dateObj);

        // ── STATUS ────────────────────────────────────────────────
        let statusText = "Pending";
        let statusCustomClass = "";
        const s = data.status?.toLowerCase();
        if (s === "success" || s === "approved") {
          statusText = "Confirmed";
          statusCustomClass = "status-confirmed-green";
        } else if (s === "failed" || s === "declined") {
          statusText = "Failed";
          statusCustomClass = "status-failed-red";
        }

        // ── LABEL & SUBTITLE ──────────────────────────────────────
        let displayLabel = label;
        let subtitle = data.description || "Transaction";

        if (name === "records") {
          if (data.type === "Admin Update") {
            displayLabel = "Admin Credit";
            subtitle = "Manual credit from admin";
          } else {
            displayLabel = "Income";
            subtitle = "Fruit basket";
          }
          statusText = "Confirmed";
          statusCustomClass = "status-confirmed-green";
        }

        if (name === "manualDeposits") {
          // Determine deposit type for the label
          if (data.isFirstDeposit === true) {
            displayLabel = "Deposit";
            subtitle = "First deposit";
          } else if (data.isRematchDeposit === true) {
            displayLabel = "Deposit";
            subtitle = "Re-deposit";
          } else {
            displayLabel = "Deposit";
            subtitle = "Bank transfer";
          }
        }

        const formattedAmt = `₦${Number(amount).toLocaleString(undefined, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })}`;

        // ── MAIN DEPOSIT CARD ─────────────────────────────────────
        const mainCard = `
          <div class="record-card" id="${rowId}">
            <div class="card-top-row">
              <span class="record-amount-label">Amount</span>
              <span class="record-amount-label" style="font-size:11.5px;">Type</span>
            </div>
            <div class="card-mid-row">
              <span class="record-amount-value">${formattedAmt}</span>
              <span class="record-status-pill ${statusCustomClass}">${statusText}</span>
            </div>
            <div class="card-mid-row" style="margin-top:-2px;">
              <span class="record-date-wrapper">
                <i class="fa-regular fa-calendar"></i> ${formattedDate}
              </span>
              <span style="font-size:12px;font-weight:500;color:var(--brand-primary-blue);">
                ${displayLabel}
              </span>
            </div>
            <div class="card-bottom-row">${subtitle}</div>
          </div>
        `;

        container.insertAdjacentHTML("afterbegin", mainCard);
        globalTrxCounter++;
        if (totalTrxCountEl) totalTrxCountEl.textContent = globalTrxCounter;

        // ── BONUS CARD (only for manualDeposits with a bonus) ─────
        if (name === "manualDeposits" && Number(data.bonusAmount || 0) > 0) {
          const bonusAmt = Number(data.bonusAmount);
          const isFirst = data.isFirstDeposit === true;
          const isRematch = data.isRematchDeposit === true;
          const bonusRowId = `bonus-${change.doc.id}`;

          // Don't render if already shown
          if (document.getElementById(bonusRowId)) return;

          // Only show bonus card if deposit is approved/success
          const depStatus = data.status?.toLowerCase();
          if (depStatus !== "success" && depStatus !== "approved") return;

          const bonusLabel = isFirst
            ? "🎁 First Deposit Bonus"
            : isRematch
              ? "🔄 Loyalty Bonus"
              : "Bonus";
          const bonusSubtitle = isFirst
            ? `10% cashback on ₦${Number(amount).toLocaleString()}`
            : `3% loyalty bonus on ₦${Number(amount).toLocaleString()}`;

          const bonusAmtFmt = `₦${bonusAmt.toLocaleString(undefined, {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          })}`;

          const bonusCard = `
            <div class="record-card" id="${bonusRowId}" style="
              border-left: 3px solid ${isFirst ? "#10b981" : "#f59e0b"};
            ">
              <div class="card-top-row">
                <span class="record-amount-label">Bonus Amount</span>
                <span class="record-amount-label" style="font-size:11.5px;">Type</span>
              </div>
              <div class="card-mid-row">
                <span class="record-amount-value" style="color:${isFirst ? "#10b981" : "#f59e0b"};">
                  +${bonusAmtFmt}
                </span>
                <span class="record-status-pill status-confirmed-green">Confirmed</span>
              </div>
              <div class="card-mid-row" style="margin-top:-2px;">
                <span class="record-date-wrapper">
                  <i class="fa-regular fa-calendar"></i> ${formattedDate}
                </span>
                <span style="font-size:12px;font-weight:600;color:${isFirst ? "#10b981" : "#f59e0b"};">
                  ${bonusLabel}
                </span>
              </div>
              <div class="card-bottom-row">${bonusSubtitle}</div>
            </div>
          `;

          container.insertAdjacentHTML("afterbegin", bonusCard);
          globalTrxCounter++;
          if (totalTrxCountEl) totalTrxCountEl.textContent = globalTrxCounter;
        }
      });
    });
  });
}

document.querySelector(".settings-item")?.addEventListener("click", () => {
  // Hide all pages safely
  if (pages && pages.length) {
    pages.forEach((p) => {
      if (p) p.style.display = "none";
    });
  }

  const recordsPage = document.getElementById("recordsPage");
  if (recordsPage) recordsPage.style.display = "block";

  const container = document.getElementById("recordsContainer");
  if (!container) return;

  loadRecords(container);
});

const withdrawalBtn = document.getElementById("withdrawalBtn");

withdrawalBtn?.addEventListener("click", () => {
  // Hide all pages safely
  if (pages && pages.length) {
    pages.forEach((p) => {
      if (p) p.style.display = "none";
    });
  }

  // Hide navbar safely
  const navbar = document.getElementById("bottomNav");
  if (navbar) navbar.style.display = "none";

  // Show records page safely
  const recordsPage = document.getElementById("recordsPage");
  if (recordsPage) recordsPage.style.display = "block";

  // Load withdrawal records
  const container = document.getElementById("recordsContainer");
  if (!container) return;

  loadWithdrawalRecords(container);
});

async function loadWithdrawalRecords(container) {
  if (!container) return;
  container.innerHTML = "";

  const user = auth.currentUser;
  if (!user) return;

  // Initialize card count tracker to dynamically update the Total Transactions panel
  let withdrawalCounter = 0;
  const totalTrxCountEl = document.getElementById("totalTrxCount");

  // 🚀 SWITCHED TO NEW DATABASE: Point query listener to coreNextDb instead of transactionDb
  const colRef = query(
    collection(coreNextDb, "withdrawals"),
    where("uid", "==", user.uid),
  );

  onSnapshot(colRef, (snapshot) => {
    snapshot.docChanges().forEach((change) => {
      if (change.type !== "added") return;

      const rowId = `withdrawals-${change.doc.id}`;
      if (document.getElementById(rowId)) return;

      const data = change.doc.data();

      // Dynamically update the premium total transactions metric text on the UI
      withdrawalCounter++;
      if (totalTrxCountEl) {
        totalTrxCountEl.textContent = withdrawalCounter;
      }

      // ===============================
      // Status Logic Mapping (Matching New Light Theme Pill Classes)
      // ===============================
      let statusText = "Pending";
      let statusCustomClass = ""; // Inherits the soft premium amber/orange style by default

      const s = data.status?.toLowerCase();

      if (s === "success" || s === "approved") {
        statusText = "Confirmed";
        statusCustomClass = "status-confirmed-green";
      } else if (s === "failed" || s === "declined") {
        statusText = "Failed";
        statusCustomClass = "status-failed-red";
      } else if (s === "processing") {
        statusText = "Processing";
        statusCustomClass = ""; // Keeps default elegant processing state look
      }

      // ---------------- TIME FORMATTING ----------------
      // Goal: 28/05/2026 format style from image
      let time = data.approvedAt || data.createdAt || data.timestamp;
      if (time?.toDate) time = time.toDate();
      else if (time) time = new Date(time);

      const formattedDate = time
        ? String(time.getDate()).padStart(2, "0") +
          "/" +
          String(time.getMonth() + 1).padStart(2, "0") +
          "/" +
          time.getFullYear()
        : "-";

      // ---------------- DATA ATTRIBUTES ----------------
      const amount = data.amount ?? data.originalAmount ?? 0;
      const subtitle = data.description || "Bank Transfer Withdrawal";

      // ---------------- NEW STYLING UI RENDER ----------------
      // Fully rewritten card blocks following the new row architecture structure
      container.insertAdjacentHTML(
        "afterbegin",
        `
        <div class="record-card" id="${rowId}">
          <div class="card-top-row">
            <span class="record-amount-label">Amount</span>
            <span class="record-amount-label" style="font-size: 11.5px;">Type</span>
          </div>

          <div class="card-mid-row">
            <span class="record-amount-value" style="color: #ea580c;">
              -₦${Number(amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
            <span class="record-status-pill ${statusCustomClass}">${statusText}</span>
          </div>

          <div class="card-mid-row" style="margin-top: -2px;">
            <span class="record-date-wrapper">
              <i class="fa-regular fa-calendar"></i> ${formattedDate}
            </span>
            <span style="font-size: 12px; font-weight: 500; color: var(--brand-primary-blue);">Withdrawal</span>
          </div>

          <div class="card-bottom-row">
            ${subtitle}
          </div>
        </div>
        `,
      );
    });
  });
}

const depositBtn = document.getElementById("depositBtnrec");

depositBtn?.addEventListener("click", () => {
  // Hide all pages safely
  if (pages && pages.length) {
    pages.forEach((p) => {
      if (p) p.style.display = "none";
    });
  }

  // Hide navbar safely
  const navbar = document.getElementById("bottomNav");
  if (navbar) navbar.style.display = "none";

  // Show records page safely
  const recordsPage = document.getElementById("recordsPage");
  if (recordsPage) recordsPage.style.display = "block";

  // Load deposit records
  const container = document.getElementById("recordsContainer");
  if (!container) return;

  loadDepositRecords(container); // Only deposits
});

async function loadDepositRecords(container) {
  if (!container) return;
  container.innerHTML = "";

  const user = auth.currentUser;
  if (!user) return;

  let depositCounter = 0;
  const totalTrxCountEl = document.getElementById("totalTrxCount");

  const collectionsToWatch = ["deposits", "manualDeposits"];

  collectionsToWatch.forEach((colName) => {
    const colRef = query(
      collection(transactionDb, colName),
      where("uid", "==", user.uid),
    );

    onSnapshot(colRef, (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type !== "added") return;

        const rowId = `${colName}-${change.doc.id}`;
        if (document.getElementById(rowId)) return;

        const data = change.doc.data();
        const amount = data.amount ?? data.originalAmount ?? 0;
        const depStatus = data.status?.toLowerCase();

        // ── STATUS ──────────────────────────────────────────────
        let statusText = "Pending";
        let statusCustomClass = "";
        if (depStatus === "success" || depStatus === "approved") {
          statusText = "Confirmed";
          statusCustomClass = "status-confirmed-green";
        } else if (depStatus === "failed" || depStatus === "declined") {
          statusText = "Failed";
          statusCustomClass = "status-failed-red";
        } else if (depStatus === "processing") {
          statusText = "Processing";
        }

        // ── DATE ────────────────────────────────────────────────
        let time = data.createdAt || data.timestamp;
        if (time?.toDate) time = time.toDate();
        else if (time) time = new Date(time);
        const formattedDate = time
          ? `${String(time.getDate()).padStart(2, "0")}/${String(time.getMonth() + 1).padStart(2, "0")}/${time.getFullYear()}`
          : "-";

        // ── DEPOSIT TYPE LABEL & SUBTITLE ────────────────────────
        const isFirst = data.isFirstDeposit === true;
        const isRematch = data.isRematchDeposit === true;
        const bonusAmt = Number(data.bonusAmount || 0);

        let typeLabel = "Deposit";
        let subtitle = "Account Balance Funding";

        // if (colName === "manualDeposits") {
        //   if (isFirst) {
        //     typeLabel = "🎁 First Deposit";
        //     subtitle = `Bank transfer · +₦${bonusAmt.toLocaleString()} (10%) bonus on approval`;
        //   } else if (isRematch) {
        //     typeLabel = "🔄 Loyalty Deposit";
        //     subtitle = `Bank transfer · +₦${bonusAmt.toLocaleString()} (3%) bonus on approval`;
        //   } else {
        //     typeLabel = "Bank Transfer";
        //     subtitle = data.description || "Manual Bank Transfer";
        //   }
        // }

        // ── MAIN DEPOSIT CARD ────────────────────────────────────
        const borderColor = isFirst
          ? "#10b981"
          : isRematch
            ? "#f59e0b"
            : "transparent";

        container.insertAdjacentHTML(
          "afterbegin",
          `
          <div class="record-card" id="${rowId}" style="border-left:3px solid ${borderColor};">
            <div class="card-top-row">
              <span class="record-amount-label">Amount</span>
              <span class="record-amount-label" style="font-size:11.5px;">Type</span>
            </div>
            <div class="card-mid-row">
              <span class="record-amount-value" style="color:#16a34a;">
                +₦${Number(amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
              <span class="record-status-pill ${statusCustomClass}">${statusText}</span>
            </div>
            <div class="card-mid-row" style="margin-top:-2px;">
              <span class="record-date-wrapper">
                <i class="fa-regular fa-calendar"></i> ${formattedDate}
              </span>
              <span style="font-size:12px;font-weight:600;color:${
                isFirst
                  ? "#10b981"
                  : isRematch
                    ? "#f59e0b"
                    : "var(--brand-primary-blue)"
              };">
                ${typeLabel}
              </span>
            </div>
            <div class="card-bottom-row">${subtitle}</div>
          </div>
        `,
        );

        depositCounter++;
        if (totalTrxCountEl) totalTrxCountEl.textContent = depositCounter;

        // ── BONUS CARD (only when approved + has bonus) ──────────
        if (
          colName === "manualDeposits" &&
          bonusAmt > 0 &&
          (depStatus === "success" || depStatus === "approved")
        ) {
          const bonusRowId = `bonus-${change.doc.id}`;
          if (document.getElementById(bonusRowId)) return;

          const bonusLabel = isFirst
            ? "🎁 First Deposit Bonus"
            : isRematch
              ? "🔄 Loyalty Bonus"
              : "Bonus";
          const bonusSubtitle = isFirst
            ? `10% cashback on ₦${Number(amount).toLocaleString()}`
            : `3% loyalty bonus on ₦${Number(amount).toLocaleString()}`;
          const bonusColor = isFirst ? "#10b981" : "#f59e0b";

          container.insertAdjacentHTML(
            "afterbegin",
            `
            <div class="record-card" id="${bonusRowId}" style="border-left:3px solid ${bonusColor};">
              <div class="card-top-row">
                <span class="record-amount-label">Bonus</span>
                <span class="record-amount-label" style="font-size:11.5px;">Type</span>
              </div>
              <div class="card-mid-row">
                <span class="record-amount-value" style="color:${bonusColor};">
                  +₦${bonusAmt.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
                <span class="record-status-pill status-confirmed-green">Confirmed</span>
              </div>
              <div class="card-mid-row" style="margin-top:-2px;">
                <span class="record-date-wrapper">
                  <i class="fa-regular fa-calendar"></i> ${formattedDate}
                </span>
                <span style="font-size:12px;font-weight:600;color:${bonusColor};">
                  ${bonusLabel}
                </span>
              </div>
              <div class="card-bottom-row">${bonusSubtitle}</div>
            </div>
          `,
          );

          depositCounter++;
          if (totalTrxCountEl) totalTrxCountEl.textContent = depositCounter;
        }
      });
    });
  });
}

const incomeBtn = document.getElementById("incomeBtn");

incomeBtn?.addEventListener("click", () => {
  // Hide all pages safely
  if (pages && pages.length) {
    pages.forEach((p) => {
      if (p) p.style.display = "none";
    });
  }

  // Hide navbar safely
  const navbar = document.getElementById("bottomNav");
  if (navbar) navbar.style.display = "none";

  // Show records page safely
  const recordsPage = document.getElementById("recordsPage");
  if (recordsPage) recordsPage.style.display = "block";

  // Load income records
  const container = document.getElementById("recordsContainer");
  if (!container) return;

  loadIncomeRecords(container); // Only investment profit
});

async function loadIncomeRecords(container) {
  if (!container) return;
  container.innerHTML = ""; // clear previous records

  const user = auth.currentUser;
  if (!user) return;

  // Initialize card count tracker to dynamically update the Total Transactions panel
  let incomeCounter = 0;
  const totalTrxCountEl = document.getElementById("totalTrxCount");

  // ---------------- GET INVESTMENT PROFIT RECORDS ----------------
  const colRef = query(
    collection(db, "users", user.uid, "records"),
    where("type", "==", "Investment Profit"),
  );

  onSnapshot(colRef, (snapshot) => {
    snapshot.docChanges().forEach((change) => {
      if (change.type !== "added") return;

      const rowId = `income-${change.doc.id}`;
      if (document.getElementById(rowId)) return;

      const data = change.doc.data();

      // Dynamically update the premium total transactions metric text on the UI
      incomeCounter++;
      if (totalTrxCountEl) {
        totalTrxCountEl.textContent = incomeCounter;
      }

      // ===============================
      // Status Logic Mapping (Matching New Light Theme Pill Classes)
      // ===============================
      // Income records use the status-confirmed-green style out of the box
      const statusText = "Confirmed";
      const statusCustomClass = "status-confirmed-green";

      // ---------------- TIME FORMATTING ----------------
      // Goal: 28/05/2026 format style from image
      let time = data.timestamp;
      if (time?.toDate) time = time.toDate();
      else if (time) time = new Date(time);

      const formattedDate = time
        ? String(time.getDate()).padStart(2, "0") +
          "/" +
          String(time.getMonth() + 1).padStart(2, "0") +
          "/" +
          time.getFullYear()
        : "-";

      // ---------------- DATA ATTRIBUTES ----------------
      const amount = data.amount ?? 0;
      const displayPlanTitle = data.plan || "Investment Profit";
      const subtitle = data.description || "Fruit Basket ROI Cycle";

      // ---------------- NEW STYLING UI RENDER ----------------
      // Fully rewritten card blocks following the new row architecture structure
      container.insertAdjacentHTML(
        "afterbegin",
        `
        <div class="record-card" id="${rowId}">
          <div class="card-top-row">
            <span class="record-amount-label">Amount</span>
            <span class="record-amount-label" style="font-size: 11.5px;">Type</span>
          </div>

          <div class="card-mid-row">
            <span class="record-amount-value" style="color: #16a34a;">
              +₦${Number(amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
            <span class="record-status-pill ${statusCustomClass}">${statusText}</span>
          </div>

          <div class="card-mid-row" style="margin-top: -2px;">
            <span class="record-date-wrapper">
              <i class="fa-regular fa-calendar"></i> ${formattedDate}
            </span>
            <span style="font-size: 12px; font-weight: 500; color: var(--brand-primary-blue);">${displayPlanTitle}</span>
          </div>

          <div class="card-bottom-row">
            ${subtitle}
          </div>
        </div>
        `,
      );
    });
  });
}

const commissionBtn = document.getElementById("commissionBtn");

commissionBtn?.addEventListener("click", () => {
  // Hide all pages safely
  if (typeof pages !== "undefined" && pages.length) {
    pages.forEach((p) => {
      if (p) p.style.display = "none";
    });
  }

  // Hide navbar
  const navbar = document.getElementById("bottomNav");
  if (navbar) navbar.style.display = "none";

  // Show records page
  const recordsPage = document.getElementById("recordsPage");
  if (recordsPage) recordsPage.style.display = "block";

  // Load ONLY commission records
  const container = document.getElementById("recordsContainer");
  if (!container) return;

  loadCommissionRecords(container);
});

async function loadCommissionRecords(container) {
  if (!container) return;
  container.innerHTML = `<p id="commission-loading-msg" style="text-align:center; padding:20px; color:#64748b; font-size:14px; margin:0;">Loading commissions...</p>`;

  const user = auth.currentUser;
  if (!user) return;

  // Initialize card count tracker to dynamically update the Total Transactions panel
  let commissionCounter = 0;
  const totalTrxCountEl = document.getElementById("totalTrxCount");

  // ✅ Point specifically to the 'records' collection in Heavy Load DB
  const colRef = query(
    collection(transactionDb, "records"),
    where("uid", "==", user.uid),
  );

  onSnapshot(colRef, (snapshot) => {
    // Clear the loader message if data exists
    const loadingMsg = document.getElementById("commission-loading-msg");
    if (!snapshot.empty && loadingMsg) {
      loadingMsg.remove();
    }

    snapshot.docChanges().forEach((change) => {
      if (change.type !== "added") return;

      const rowId = `commission-${change.doc.id}`;
      if (document.getElementById(rowId)) return;

      const data = change.doc.data();

      // Dynamically update the premium total transactions metric text on the UI
      commissionCounter++;
      if (totalTrxCountEl) {
        totalTrxCountEl.textContent = commissionCounter;
      }

      // ===============================
      // Status Logic Mapping (Matching New Light Theme Pill Classes)
      // ===============================
      const statusText = "Confirmed";
      const statusCustomClass = "status-confirmed-green";

      // ---------------- TIME FORMATTING ----------------
      // Goal: 28/05/2026 format style from image
      let time = data.timestamp || data.createdAt;
      if (time?.toDate) time = time.toDate();
      else if (time) time = new Date(time);

      const formattedDate = time
        ? String(time.getDate()).padStart(2, "0") +
          "/" +
          String(time.getMonth() + 1).padStart(2, "0") +
          "/" +
          time.getFullYear()
        : "-";

      // ---------------- DATA ATTRIBUTES ----------------
      const amount = data.amount || 0;
      const displayLabel = "Affiliate Reward";
      const subtitle = `From: ${data.refNumber || "Referral"} (Level ${data.level || "1"})`;

      // ---------------- NEW STYLING UI RENDER ----------------
      // Fully rewritten card blocks following the new row architecture structure
      container.insertAdjacentHTML(
        "afterbegin",
        `
        <div class="record-card" id="${rowId}">
          <div class="card-top-row">
            <span class="record-amount-label">Amount</span>
            <span class="record-amount-label" style="font-size: 11.5px;">Type</span>
          </div>

          <div class="card-mid-row">
            <span class="record-amount-value" style="color: #16a34a;">
              +₦${Number(amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
            <span class="record-status-pill ${statusCustomClass}">${statusText}</span>
          </div>

          <div class="card-mid-row" style="margin-top: -2px;">
            <span class="record-date-wrapper">
              <i class="fa-regular fa-calendar"></i> ${formattedDate}
            </span>
            <span style="font-size: 12px; font-weight: 500; color: var(--brand-primary-blue);">${displayLabel}</span>
          </div>

          <div class="card-bottom-row">
            ${subtitle}
          </div>
        </div>
        `,
      );
    });

    if (snapshot.empty) {
      container.innerHTML = `<div style="text-align:center; padding:40px; color:#94a3b8; font-size:14px;">No commissions earned yet.</div>`;
    }
  });
}

document.addEventListener("DOMContentLoaded", () => {
  // Select the grid buttons and input
  const amountOptions = document.querySelectorAll(".amount-option");
  const customAmountInput = document.getElementById("customAmount");
  const selectedAmountDisplay = document.getElementById(
    "selectedAmountDisplay",
  );

  // Optional: update header display
  const headerSelectedAmount = document.getElementById("headerSelectedAmount");

  let selectedAmount = 0;

  function updateSelectedAmountDisplay() {
    const formatted = selectedAmount
      ? `₦${Number(selectedAmount).toLocaleString()}`
      : "₦0";

    const display = document.getElementById("selectedAmountDisplay");
    if (display) display.textContent = formatted;

    const headerDisplay = document.getElementById("headerSelectedAmount");
    if (headerDisplay) headerDisplay.textContent = formatted;
  }

  // ===== Grid Amount Click =====
  amountOptions.forEach((option) => {
    option.addEventListener("click", () => {
      selectedAmount = option.dataset.value;

      // Fill custom input with the clicked amount
      customAmountInput.value = selectedAmount;

      // Update top amount display
      updateSelectedAmountDisplay();

      // Highlight active grid button
      amountOptions.forEach((o) => o.classList.remove("active"));
      option.classList.add("active");
    });
  });

  // ===== Custom Amount Input =====
  customAmountInput.addEventListener("input", () => {
    selectedAmount = customAmountInput.value;

    // Update top display
    updateSelectedAmountDisplay();

    // Remove active class from grid buttons
    amountOptions.forEach((o) => o.classList.remove("active"));
  });
});

document.addEventListener("DOMContentLoaded", function () {
  const nav = document.getElementById("bottomNav");

  if (!nav) {
    console.error("❌ Bottom navbar NOT found in HTML");
    return;
  }

  console.log("✅ Bottom navbar FOUND");

  // Force it visible (in case CSS hides it)
  nav.style.display = "flex";
  nav.style.visibility = "visible";
  nav.style.opacity = "1";
  nav.style.position = "fixed";
  nav.style.bottom = "0";
  nav.style.left = "0";
  nav.style.width = "100%";
  nav.style.zIndex = "99999";
});

// Scroll to last content in records page
function scrollToBottom() {
  const recordsPage = document.querySelector(".records-page");
  if (recordsPage) {
    recordsPage.scrollTop = recordsPage.scrollHeight;
  }
}

// Call after content is loaded or updated
scrollToBottom();

// ✅ PLACE THIS OUTSIDE ALL OTHER FUNCTIONS (Global Scope)
function toggleVisibility(inputId, iconEl) {
  const input = document.getElementById(inputId);
  if (!input) return;

  if (input.type === "password") {
    input.type = "text";
    // Change icon to See-No-Evil Monkey (🙉) (Acting as "Visible")
    iconEl.textContent = "🙉";
    iconEl.style.color = "var(--accent-purple)"; // Optional: Make it purple when showing
  } else {
    input.type = "password";
    // Change back to Hear-No-Evil Monkey (🙈) (Acting as "Hidden")
    iconEl.textContent = "🙈";
    iconEl.style.color = "#a1a7b3"; // Optional: Back to neutral
  }
}
// ONLY DO THIS IF YOU USE type="module"
window.toggleVisibility = toggleVisibility;

// --- POPULATE BANKS IMMEDIATELY ---
document.addEventListener("DOMContentLoaded", function () {
  const bankSelect = document.getElementById("bankName");

  // Filtered Bank List explicitly matching your live Payrant API Payload
  const banks = [
    { name: "5TT MFB", code: "090832" },
    { name: "78 FINANCE COMPANY LIMITED", code: "110072" },
    { name: "9 PSB", code: "120001" },
    { name: "9jaPay", code: "090629" },
    { name: "AAA FINANCE", code: "050005" },
    { name: "AACB MFB", code: "091013" },
    { name: "AB MICROFINANCE BANK", code: "090270" },
    { name: "ABBEY MORTGAGE BANK", code: "070010" },
    { name: "ABOVE ONLY MICROFINANCE BANK", code: "090260" },
    { name: "ABSU Microfinance Bank", code: "090640" },
    { name: "ABU MICROFINANCE BANK", code: "090197" },
    { name: "Abucoop Microfinance BANK", code: "090424" },
    { name: "ABULESORO MICROFINANCE BANK LTD", code: "090545" },
    { name: "Access Bank", code: "000014" },
    { name: "Access Bank (Diamond)", code: "000005" },
    { name: "ACCESS Y'ello & Beta", code: "100052" },
    { name: "ACCESSMONEY", code: "100013" },
    { name: "ACCION MFB", code: "090134" },
    { name: "Ada MFB", code: "090483" },
    { name: "ADAMAWA MORTGAGE BANK", code: "070030" },
    { name: "ADDOSSER MFB", code: "090160" },
    { name: "ADEYEMI COLLEGE STAFF MICROFINANCE BANK", code: "090268" },
    { name: "Advancly MFB", code: "090759" },
    { name: "ADVANS LA FAYETTE MFB", code: "090155" },
    { name: "Aella MFB", code: "090614" },
    { name: "Afekhafe MFB", code: "090292" },
    { name: "Afemai Microfinance Bank", code: "090518" },
    { name: "AFOLE MFB", code: "091017" },
    { name: "AFRIBANK NIGERIA PLC", code: "014" },
    { name: "AG MORTGAGE BANK PLC", code: "100028" },
    { name: "AGOSASA MICROFINANCE BANK", code: "090371" },
    { name: "Akalabo MFB", code: "090698" },
    { name: "Akpo Microfinance Bank", code: "090608" },
    { name: "AKSU MFB", code: "090756" },
    { name: "AKU DIEWA MFB", code: "091009" },
    { name: "Aku MFB", code: "090531" },
    { name: "AKUCHUKWU MICROFINANCE BANK LTD", code: "090561" },
    { name: "AL-BARKAH MFB", code: "090133" },
    { name: "ALEKUN MICROFINANCE BANK", code: "090259" },
    { name: "ALERT MFB", code: "090297" },
    { name: "ALHAYAT MFB", code: "090277" },
    { name: "ALLWORKERS MFB", code: "090131" },
    { name: "ALLY MICROFINANCE BANK", code: "090548" },
    { name: "ALPHA MORGAN BANK", code: "000041" },
    { name: "ALPHAKAPITAL MFB", code: "090169" },
    { name: "Alternative Bank Limited", code: "000037" },
    { name: "Alvana Microfinance BANK", code: "090489" },
    { name: "AMAANAH FINANCE", code: "050045" },
    { name: "Amac Microfinance BANK", code: "090394" },
    { name: "AMJU MFB", code: "090180" },
    { name: "AMML MFB", code: "090116" },
    { name: "AMOYE MFB", code: "090610" },
    { name: "Ample MFB", code: "090770" },
    { name: "AMS FINANCE", code: "050048" },
    { name: "Anchorage MFB", code: "090476" },
    { name: "Aniocha MFB", code: "090469" },
    { name: "ANIOMA MFB", code: "090751" },
    { name: "APEKS MICROFINANCE BANK", code: "090143" },
    { name: "Apex Trust MFB", code: "090737" },
    { name: "APPLE MICROFINANCE BANK", code: "090376" },
    { name: "Aramoko Microfinance Bank", code: "090307" },
    { name: "ARCPAY Microfinance", code: "090689" },
    { name: "ARISE MFB", code: "090282" },
    { name: "ARM MFB", code: "090816" },
    { name: "ASCENSIA FINANCE COMPANY LIMITED", code: "050040" },
    { name: "ASHA MICROFINANCE BANK", code: "091018" },
    { name: "Aso Savings and Loans", code: "090001" },
    { name: "ASPIRE MICROFINANCE BANK LTD", code: "090544" },
    { name: "ASPIRE MORTGAGE BANK LIMITED", code: "070033" },
    { name: "Assets Matrix MFB", code: "090287" },
    { name: "ASSETS Microfinance BANK", code: "090473" },
    { name: "ASTRAPOLARIS MFB", code: "090172" },
    { name: "ATBU Microfinance BANK", code: "090451" },
    { name: "AUCHI MICROFINANCE BANK", code: "090264" },
    { name: "AUCHI POLY MFB", code: "090817" },
    { name: "AVE MARIA MICROFINANCE BANK LTD", code: "090600" },
    { name: "AVEST MICROFINANCE BANK", code: "091012" },
    { name: "Avuenegbe MFB", code: "090478" },
    { name: "AVVIC MFB", code: "090853" },
    { name: "Awacash Microfinance Bank", code: "090633" },
    { name: "Awe MFB", code: "090693" },
    { name: "Awesome MFB", code: "090662" },
    { name: "Aztec Microfinance Bank", code: "090540" },
    { name: "BABCOCK MFB", code: "090729" },
    { name: "BABURA MICROFINANCE BANK", code: "090625" },
    { name: "BAIGE MFB", code: "090862" },
    { name: "BAINES CREDIT MFB", code: "090188" },
    { name: "BALERA MICROFINANCE BANK LTD", code: "090563" },
    { name: "Balogun Fulani Microfinance BANK", code: "090181" },
    { name: "BALOGUN GAMBARI MFB", code: "090326" },
    { name: "BAM MFB", code: "090651" },
    { name: "BANC CORP MICROFINANCE BANK", code: "090581" },
    { name: "Banex Microfinance BANK", code: "090425" },
    { name: "BANK OF AGRICULTURE", code: "090367" },
    { name: "BANK78 MFB", code: "090866" },
    { name: "Bankeasy MFB", code: "090789" },
    { name: "BANKIT MFB", code: "090726" },
    { name: "Bankly Microfinance Bank", code: "090529" },
    { name: "BAOBAB MICROFINANCE BANK", code: "090136" },
    { name: "BARNAWA MFB", code: "090783" },
    { name: "Bauchi CFA Microfinance Bank", code: "090387" },
    { name: "BAYERO MICROFINANCE BANK", code: "090316" },
    { name: "BC KASH MFB", code: "090127" },
    { name: "Beamer MFB", code: "090591" },
    { name: "BELLBANK MFB", code: "090672" },
    { name: "Benysta Microfinance BANK", code: "090413" },
    { name: "Berachah Microfinance Bank", code: "090618" },
    { name: "CITY CODE MORTGAGE BANK", code: "070027" },
    { name: "Cloverleaf MFB", code: "090511" },
    { name: "CoalCamp Microfinance BANK", code: "090254" },
    { name: "COASTLINE MICROFINANCE BANK", code: "090374" },
    { name: "CONFIDENCE MICROFINANCE BANK LTD", code: "090530" },
    { name: "CONSISTENT TRUST MICROFINANCE BANK LTD", code: "090553" },
    { name: "CONSUMER MFB", code: "090130" },
    { name: "COOL MFB", code: "090842" },
    { name: "COOP Mortgage BANK", code: "070021" },
    { name: "COOPFUND MFB", code: "090717" },
    { name: "Corestep MICROFINANCE BANK", code: "090365" },
    { name: "Coronation", code: "060001" },
    { name: "COUNTY FINANCE LTD", code: "050001" },
    { name: "COVENANT MFB", code: "070006" },
    { name: "CREDIT AFRIQUE MFB", code: "090159" },
    { name: "Credit Direct Limited", code: "110049" },
    { name: "Creditville MFB", code: "090611" },
    { name: "Crescent Microfinance bank", code: "090526" },
    { name: "CROSS RIVER MICROFINANCE BANK", code: "090429" },
    { name: "CRUTECH MICROFINANCE BANK", code: "090414" },
    { name: "CRYSTAL FINANCE COMPANY LIMITED", code: "050029" },
    { name: "CSD MFB", code: "090686" },
    { name: "DAL Microfinance Bank", code: "090596" },
    { name: "DASH MFB", code: "090845" },
    { name: "DAVENPORT MFB", code: "090673" },
    { name: "Davodani Microfinance BANK", code: "090391" },
    { name: "DAYLIGHT MICROFINANCE BANK", code: "090167" },
    { name: "DAYSPRING MFB", code: "090873" },
    { name: "DEC-ENUGU MFB", code: "090995" },
    { name: "Delta Trust Mortgage bank", code: "070023" },
    { name: "DESTINY MFB", code: "090723" },
    { name: "Digitvant MFB", code: "090745" },
    { name: "Dignity Finance", code: "050013" },
    { name: "DILLON MFB", code: "090828" },
    { name: "DIOBU MICROFINANCE BANK", code: "090643" },
    { name: "Doje Microfinance Bank Limited", code: "090404" },
    { name: "DOT MFB", code: "090470" },
    { name: "DSC MFB", code: "090821" },
    { name: "DUXBANK MFB", code: "090847" },
    { name: "DW MFB", code: "090721" },
    { name: "E-BARCS MFB", code: "090156" },
    { name: "E-Finance", code: "050016" },
    { name: "EAGLE FLIGHT MFB", code: "090294" },
    { name: "EARNWELL MFB", code: "090674" },
    { name: "Eartholeum", code: "100021" },
    { name: "Eastman MFB", code: "090707" },
    { name: "EBSU MICROFINANCE BANK", code: "090427" },
    { name: "Ecobank Mobile", code: "307" },
    { name: "Ecobank Nigeria", code: "000010" },
    { name: "Ecobank Xpress Account", code: "100008" },
    { name: "EDFIN MFB", code: "090310" },
    { name: "EGWAFIN MICROFINANCE BANK LTD", code: "090556" },
    { name: "EJINDU MFB", code: "090694" },
    { name: "EK-Reliable Microfinance BANK", code: "090389" },
    { name: "EKIMOGUN MICROFINANCE BANK", code: "090552" },
    { name: "EKONDO MFB", code: "090097" },
    { name: "EKWULOBIA MFB", code: "091010" },
    { name: "ELLINGTON MFB", code: "090811" },
    { name: "EMAAR MICROFINANCE BANK LTD", code: "090712" },
    { name: "EMERALDS MFB", code: "090273" },
    { name: "EMINENCE MFB", code: "091002" },
    { name: "EMPIRETRUST MICROFINANCE BANK", code: "090114" },
    { name: "eNaira(e-Naira)", code: "000033" },
    { name: "Enco Finance", code: "050012" },
    { name: "Enrich Microfinance Bank", code: "090539" },
    { name: "ENTERPRISE BANK LIMITED", code: "000019" },
    { name: "Entity MFB", code: "090656" },
    { name: "EQUATOR MICROFINANCE BANK", code: "090872" },
    { name: "ESAN MFB", code: "090189" },
    { name: "ESO-E MICROFINANCE BANK", code: "090166" },
    { name: "ETHICA MFB", code: "090982" },
    { name: "eTranzact", code: "100006" },
    { name: "EVANGEL MFB", code: "090304" },
    { name: "EVERGREEN MICROFINANCE BANK", code: "090332" },
    { name: "EVIB FINANCE", code: "050034" },
    { name: "EWT Microfinance Bank", code: "090572" },
    { name: "EXCEL MFB", code: "090678" },
    { name: "EXCELLENT MICROFINANCE BANK", code: "090541" },
    { name: "EYOWO MICROFINANCE BANK", code: "090328" },
    { name: "FACTORING AND SUPPLY CHAIN FINANCE LIMITED", code: "050042" },
    { name: "Fairmoney MFB", code: "090551" },
    { name: "FAME MICROFINANCE BANK", code: "090330" },
    { name: "FAST CREDIT", code: "050009" },
    { name: "FAST Microfinance BANK", code: "090179" },
    { name: "FBN MOBILE", code: "309" },
    { name: "FBNQuest MERCHANT BANK", code: "060002" },
    { name: "FCMB Easy Account", code: "100031" },
    { name: "FCMB MFB", code: "090409" },
    { name: "FCT MFB", code: "090290" },
    { name: "Federal Polytechnic Nekede Microfinance BANK", code: "090398" },
    { name: "FEDERALPOLY NASARAWAMFB", code: "090298" },
    { name: "Fedeth MFB", code: "090482" },
    { name: "FETS", code: "100001" },
    { name: "FEWCHORE FINANCE COMPANY LIMITED", code: "050002" },
    { name: "FFS MICROFINANCE BANK", code: "090153" },
    { name: "FHA MORTGAGE BANK LTD", code: "070026" },
    { name: "Fidelity Bank", code: "000007" },
    { name: "Fidelity Mobile", code: "100019" },
    { name: "FIDFUND MFB", code: "090126" },
    { name: "FIMS MFB", code: "090507" },
    { name: "FINATRUST MICROFINANCE BANK", code: "090111" },
    { name: "Finca Microfinance BANK", code: "090400" },
    { name: "Firmus MICROFINANCE BANK", code: "090366" },
    { name: "FIRST ALLY MICROFINANCE BANK", code: "090135" },
    { name: "First Bank Of Nigeria", code: "000016" },
    { name: "First City Monument Bank", code: "000003" },
    { name: "First Generation Mortgage Bank", code: "070014" },
    // Filtered Bank List explicitly matching your live Payrant API Payload
    { name: "Gabasawa MFB", code: "090582" },
    { name: "GADOL FINANCE", code: "050333" },
    { name: "Garki MFB", code: "090484" },
    { name: "Garun Mallam MFB", code: "090691" },
    { name: "GASHUA MICROFINANCE BANK", code: "090168" },
    { name: "GATEWAY MORTGAGE BANK", code: "070009" },
    { name: "GBEDE Microfinance Bank", code: "090579" },
    { name: "Giant Stride MFB", code: "090475" },
    { name: "GIDAUNIYAR ALHERI MICROFINANCE BANK", code: "090621" },
    { name: "Giginya MFB", code: "090632" },
    { name: "GiGinya Microfinance BANK", code: "090411" },
    { name: "Girei MFB", code: "090186" },
    { name: "GIWA MICROFINANCE BANK", code: "090441" },
    { name: "GLOBAL INITIATIVE MFB", code: "090639" },
    { name: "GLOBAL TRUST SAVINGS AND LOANS", code: "070032" },
    { name: "Globus Bank", code: "000027" },
    { name: "GLORY MFB", code: "090278" },
    { name: "GMB Microfinance BANK", code: "090408" },
    { name: "GOLDMAN MICROFINANCE BANK LTD", code: "090574" },
    { name: "GOMBE MFB", code: "090586" },
    { name: "GoMoney", code: "100022" },
    { name: "Good Neighbours Microfinance BANK", code: "090467" },
    { name: "GOOD SHEPHARD MFB", code: "090664" },
    { name: "Gosifechukwu MFB", code: "090687" },
    { name: "GOWANS MFB", code: "090122" },
    { name: "Grant Microfinance BANK", code: "090335" },
    { name: "GREEN ENERGY MICROFINANCE BANK LTD", code: "090550" },
    { name: "Greenacres MFB", code: "090599" },
    { name: "GREENBANK MFB", code: "090178" },
    { name: "GREENVILLE MICROFINANCE BANK", code: "090269" },
    { name: "GREENWICH MERCHANT BANK", code: "060004" },
    { name: "GRIFFIN FINANCE LIMITED", code: "050041" },
    { name: "GROOMING MICROFINANCE BANK", code: "090195" },
    { name: "GTBank", code: "000013" },
    { name: "GTBank Mobile Money", code: "100009" },
    { name: "GTI Microfinance BANK", code: "090385" },
    { name: "Gwong Microfinance bank", code: "090500" },
    // Filtered Bank List explicitly matching your live Payrant API Payload
    { name: "HACKMAN MICROFINANCE BANK", code: "090147" },
    { name: "Haggai Mortgage Bank", code: "070017" },
    { name: "HalaCredit MFB", code: "090291" },
    { name: "HASAL MFB", code: "090121" },
    { name: "HAYAT TRUST MFB", code: "090777" },
    { name: "Headway MFB", code: "090363" },
    { name: "HEDGE MFB", code: "091025" },
    { name: "Hedonmark", code: "100017" },
    { name: "Highland Microfinance BANK", code: "090418" },
    { name: "HomeBase Mortgage", code: "070024" },
    { name: "HopePSB", code: "120002" },
    { name: "I-MONIE Microfinance Bank", code: "090426" },
    { name: "IBA MFB", code: "090598" },
    { name: "IBBU MFB", code: "090697" },
    { name: "IBETO MICROFINANCE BANK", code: "090439" },
    { name: "IBILE MICROFINANCE BANK", code: "090118" },
    { name: "IBOLO MICORFINANCE BANK LTD", code: "090532" },
    { name: "Ibom fadama Microfinance Bank", code: "090519" },
    { name: "Ibom Mortgage Bank", code: "070025" },
    { name: "Ibu-Aje Microfinance", code: "090488" },
    { name: "IC GLOBALMicrofinance bank", code: "090520" },
    { name: "IHIALA MFB", code: "090725" },
    { name: "IJARE MFB", code: "090730" },
    { name: "IJEBU-IFE MICROFINANCE BANK LTD", code: "090546" },
    { name: "IKENNE MFB", code: "090324" },
    { name: "IKERE MFB", code: "090799" },
    { name: "IKIRE MFB", code: "090279" },
    { name: "IKORODU DIVISION MFB", code: "090844" },
    { name: "IKOYI ILE MFB", code: "090681" },
    { name: "Ikoyi-Osun Microfinance Bank", code: "090536" },
    { name: "ILARO POLY MICROFINANCE BANK LTD", code: "090571" },
    { name: "ILASAN MICROFINANCE BANK", code: "090370" },
    { name: "ILE-OLUJI MICROFINANCE BANK", code: "090710" },
    { name: "Ilora Microfinance BANK", code: "090430" },
    { name: "ILORIN MICROFINANCE BANK", code: "090350" },
    { name: "ILUTITUN-OSORO MFB", code: "090834" },
    { name: "IMO MICROFINANCE BANK", code: "090258" },
    { name: "Imowo Microfinance BANK", code: "090417" },
    { name: "Imperial Homes Mortgage Bank", code: "100024" },
    { name: "IMSU MFB", code: "090670" },
    { name: "INDULGE MFB", code: "090772" },
    { name: "INEBA", code: "080838" },
    { name: "INEBA GOGO MICROFINANCE BANK LIMITED", code: "090838" },
    { name: "INFINITY MFB", code: "090157" },
    { name: "Infinity trust  Mortgage Bank", code: "070016" },
    { name: "Innovative MFB", code: "090115" },
    { name: "Insight Microfinance BANK", code: "090434" },
    { name: "Intellifin", code: "100027" },
    { name: "Interland MFB", code: "090386" },
    { name: "Interswitch Financial Inclusion Services (IFIS)", code: "110010" },
    { name: "INVESTIN MICROFINANCE BANK", code: "090998" },
    { name: "Iperu Microfinance BANK", code: "090493" },
    { name: "IRL MICROFINANCE BANK", code: "090149" },
    { name: "ISALEOYO MICROFINANCE BANK", code: "090377" },
    { name: "Ishie Microfinance BANK", code: "090428" },
    { name: "ISI UZO MFB", code: "090849" },
    { name: "ISLAND MFB", code: "090584" },
    { name: "Isuofia MFB", code: "090353" },
    { name: "IWADE MICROFINANCE BANK LTD", code: "090578" },
    { name: "IWOAMA MICROFINANCE BANK", code: "090543" },
    { name: "IYAMOYE MICROFINANCE BANK LTD", code: "090570" },
    { name: "IYERU OKIN MICROFINANCE BANK LTD", code: "090337" },
    { name: "Izon Microfinance BANK", code: "090421" },
    // Filtered Bank List explicitly matching your live Payrant API Payload
    { name: "MAAL MFB", code: "090764" },
    { name: "Mab Allianz MFB", code: "090623" },
    { name: "Mabinas MFB", code: "090630" },
    { name: "Macrod MFB", code: "090603" },
    { name: "Maestro MFB", code: "090746" },
    { name: "MAHFUZ MFB", code: "090825" },
    { name: "MAINLAND MICROFINANCE BANK", code: "090323" },
    { name: "MAINSTREET MFB", code: "090171" },
    { name: "Maintrust MFB", code: "090465" },
    { name: "MALACHY MFB", code: "090174" },
    { name: "MANNY MICROFINANCE BANK", code: "090383" },
    { name: "Mautech Microfinance BANK", code: "090423" },
    { name: "MAXITRUST MFB", code: "090843" },
    { name: "MAYDEN MFB", code: "090854" },
    { name: "MAYFAIR MFB", code: "090321" },
    { name: "MAYFRESH MORTGAGE BANK", code: "070019" },
    { name: "Medef MFB", code: "090612" },
    { name: "MEGA MICROFINANCE BANK", code: "090824" },
    { name: "MEGAPRAISE MICROFINANCE BANK", code: "090280" },
    { name: "Memphis Microfinance BANK", code: "090432" },
    { name: "MERCURY MICROFINANCE BANK", code: "090589" },
    { name: "Mgbidi Microfinance Bank", code: "090528" },
    { name: "MIA MICROFINANCE BANK", code: "090859" },
    { name: "MICROBIZ MFB", code: "090587" },
    { name: "MICROFINANCE BANK MEMENT", code: "090867" },
    { name: "MICROVIS MICROFINANCE BANK", code: "090113" },
    { name: "Midland MFB", code: "090192" },
    { name: "MINJIBIR MICROFINANCE BANK", code: "090607" },
    { name: "MINT MFB", code: "090763" },
    { name: "MINT-FINEX MFB", code: "090281" },
    { name: "Mkobo Microfinance Bank", code: "090455" },
    { name: "Mkudi", code: "100011" },
    { name: "MODEL MFB", code: "090775" },
    { name: "MOLUSI MICROFINANCE BANK", code: "090362" },
    { name: "MoMo PSB", code: "120003" },
    { name: "Monarch Microfinance BANK", code: "090462" },
    { name: "Money Master PSB", code: "120005" },
    { name: "MoneyBox", code: "100020" },
    { name: "MONEYFIELD MICROFINANCE BANK", code: "090144" },
    { name: "MONEYTRONICS MFB", code: "090692" },
    { name: "MONEYTRUST MFB", code: "090129" },
    { name: "Moniepoint", code: "090405" },
    { name: "Moremonee MFB", code: "090685" },
    { name: "MOUA MFB", code: "090659" },
    { name: "MOVASCO-OP MFB", code: "090979" },
    { name: "MOYOFADE MICROFINANCE BANK", code: "090448" },
    { name: "Mozfin Microfinance BANK", code: "090392" },
    { name: "Mutual Alliance Mortgage Bank", code: "070028" },
    { name: "MUTUAL BENEFITS MFB", code: "090190" },
    { name: "MUTUAL TRUST MICROFINANCE BANK", code: "090151" },
    { name: "NAF MFB", code: "090740" },
    { name: "Nomase MFB", code: "090736" },
    { name: "Nombank MFB", code: "090645" },
    { name: "NORTHQUEST FINANCE", code: "050030" },
    { name: "NOUN MFB", code: "090822" },
    { name: "Nova Bank", code: "060003" },
    { name: "NOVEL MICROFINANCE BANK", code: "090863" },
    { name: "NOVUS MFB", code: "090734" },
    { name: "NOWNOW（Contec Global）", code: "100032" },
    { name: "NPF MICROFINANCE BANK", code: "070001" },
    { name: "Npolu-UST Microfinance Bank", code: "090535" },
    { name: "Nsehe Microfinance Bank", code: "090628" },
    { name: "Nsuk Microfinance BANK", code: "090491" },
    { name: "NSUKKA MFB", code: "090356" },
    { name: "NUGGETS MFB", code: "090676" },
    { name: "Numo Microfinance bank", code: "090516" },
    { name: "NUTURE MFB", code: "090364" },
    { name: "Nwannegadi MFB", code: "090399" },
    { name: "OAKLAND MICROFINANCE BANK", code: "090437" },
    { name: "OAU MICROFINANCE BANK LTD", code: "090345" },
    { name: "OBA MICROFINANCE BANK", code: "090981" },
    { name: "OBELEDU MFB", code: "090755" },
    { name: "OBOLLO MFB", code: "090810" },
    { name: "OCHE MFB", code: "090333" },
    { name: "OCTOPUS MICROFINANCE BANK LTD", code: "090576" },
    { name: "Odoakpu MFB", code: "090654" },
    { name: "OGANIRU MFB", code: "091011" },
    { name: "Ogberuru Microfinance Bank", code: "090738" },
    { name: "Ogige MFB", code: "090739" },
    { name: "OHAFIA MFB", code: "090119" },
    { name: "OHHA MICROFINANCE BANK", code: "090626" },
    { name: "Ojokoro Mfb", code: "090527" },
    { name: "OKE-ARO OREDEGBE MICROFINANCE BANK LTD", code: "090565" },
    { name: "Okengwe MFB", code: "090646" },
    { name: "OKPE MFB", code: "090855" },
    { name: "OKPOGA MFB", code: "090161" },
    { name: "OKUKU MICROFINANCE BANK LTD", code: "090566" },
    { name: "OKWO-OHA MFB", code: "090752" },
    { name: "OLABISI ONABANJO UNIVERSITY MICROFINANCE BANK", code: "090272" },
    { name: "Old Shoreham MFB", code: "090410" },
    { name: "OLIVE MFB", code: "090696" },
    { name: "OLOFIN OWENA Microfinance BANK", code: "090468" },
    { name: "OLOMU APERAN MFB", code: "090852" },
    { name: "OLUCHUKWU Microfinance BANK", code: "090471" },
    { name: "Omak MFB", code: "090700" },
    { name: "OMIYE MFB", code: "090295" },
    { name: "OneUtility MFB", code: "090605" },
    { name: "OPay", code: "100004" },
    { name: "OPTIMUS BANK", code: "000036" },
    { name: "Oraukwu Microfinance BANK", code: "090492" },
    { name: "ORISUN MFB", code: "090588" },
    { name: "ORITABASORUN MICROFINANCE BANK", code: "090460" },
    { name: "OSANTA MICROFINANCE BANK", code: "090750" },
    { name: "Oscotech MFB", code: "090396" },
    { name: "OSOMHE MFB", code: "090715" },
    // Filtered Bank List explicitly matching your live Payrant API Payload
    { name: "PalmPay", code: "100033" },
    { name: "PARRALEX", code: "090004" },
    { name: "PATHFINDER MFB", code: "090680" },
    { name: "PATRICK GOLD", code: "090317" },
    { name: "PayAttitude Online", code: "110001" },
    { name: "PAYREP MICROFINANCE BANK LIMITED", code: "090823" },
    { name: "PAYSTACK MFB", code: "090986" },
    { name: "Paystack-Titan", code: "100039" },
    { name: "Peace Microfinance BANK", code: "090402" },
    { name: "PECAN TRUST MICROFINANCE BANK", code: "090137" },
    { name: "PENIEL MICORFINANCE BANK LTD", code: "090379" },
    { name: "PENNYWISE MICROFINANCE BANK", code: "090196" },
    { name: "PENTECOST MFB", code: "090861" },
    { name: "PETRA MICROFINANCE BANK", code: "090165" },
    { name: "PETTYSAVE MFB", code: "090768" },
    { name: "PILLAR MFB", code: "090289" },
    { name: "Platinum MFB", code: "090993" },
    { name: "PLATINUM MORTGAGE BANK", code: "070013" },
    { name: "PLUG MICROFINANCE BANK", code: "090858" },
    { name: "POCKETAPP", code: "100042" },
    { name: "Poder Finance", code: "050021" },
    { name: "POINTONE MFB", code: "090754" },
    { name: "Polaris Bank", code: "000008" },
    { name: "Polyibadan Microfinance Bank", code: "090534" },
    { name: "POLYUWANNA MFB", code: "090296" },
    { name: "Preeminent Microfinance BANK", code: "090412" },
    { name: "PREMIER MFB", code: "090779" },
    { name: "Premium Trust bank", code: "000031" },
    { name: "PRESTIGE MICROFINANCE BANK", code: "090274" },
    { name: "Prisco Microfinance BANK", code: "090481" },
    { name: "Pristine Divitis Microfinance BANK", code: "090499" },
    { name: "PRODIGY MFB", code: "090784" },
    { name: "Projects Microfinance bank", code: "090503" },
    { name: "Prospa Capital Microfinance Bank", code: "090495" },
    { name: "Prosperity Microfinance Bank", code: "090642" },
    { name: "Providus Bank", code: "000023" },
    { name: "Prudent MFB", code: "090690" },
    { name: "PURPLEMONEY MFB", code: "090303" },
    { name: "PYRAMID MFB", code: "090657" },
    // Filtered Bank List explicitly matching your live Payrant API Payload
    { name: "QUBE MICROFINANCE BANK LTD", code: "090569" },
    { name: "QUICK MFB", code: "090850" },
    { name: "QUICKFUND MICROFINANCE BANK", code: "090261" },
    { name: "Radalpha Microfinance bank", code: "090496" },
    { name: "RAHAMA MFB", code: "090170" },
    { name: "Rand Merchant Bank", code: "000024" },
    { name: "RANK MFB", code: "090860" },
    { name: "RAYYAN MFB", code: "090616" },
    { name: "Refuge Mortgage Bank", code: "070011" },
    { name: "REGENT MFB", code: "090125" },
    { name: "Rehoboth Microfinance BANK", code: "090463" },
    { name: "RELIANCE MFB", code: "090173" },
    { name: "RENMONEY MICROFINANCE BANK", code: "090198" },
    { name: "REPHIDIM MFB", code: "090322" },
    { name: "RESIDENT FINTECH LTD", code: "110024" },
    { name: "RETRUST MFB", code: "090766" },
    { name: "REVELATION MFB", code: "090666" },
    { name: "REXEL", code: "110046" },
    { name: "RICHWAY MFB", code: "090132" },
    { name: "RIGO Microfinance BANK", code: "090433" },
    { name: "Rima Growth Pathway Microfinance Bank", code: "090515" },
    { name: "RIMA Microfinance BANK", code: "090443" },
    { name: "Rimin Gado MFB", code: "090713" },
    { name: "ROCKSHIELD MICROFINANCE BANK", code: "090547" },
    { name: "Royal Blue MFB", code: "090622" },
    { name: "ROYAL EXCELLENT MICROFINANCE BANK", code: "090990" },
    { name: "ROYAL EXCHANGE MICROFINANCE BANK", code: "090138" },
    { name: "RUBIES MFB", code: "090175" },
    { name: "RUN MFB", code: "090771" },
    // Filtered Bank List explicitly matching your live Payrant API Payload
    { name: "SAFEGATE MICROFINANCE BANK", code: "090485" },
    { name: "SAFELINE MFB", code: "090875" },
    { name: "SAFETRUST", code: "090006" },
    { name: "SAGAMU MICROFINANCE BANK", code: "090140" },
    { name: "SageGrey Finance Limited", code: "050003" },
    { name: "SCIART FINANCE", code: "050024" },
    { name: "SEAP Microfinance Bank", code: "090513" },
    { name: "SEED CAPITAL MICROFINANCE BANK", code: "090112" },
    { name: "SEEDVEST MICROFINANCE BANK", code: "090369" },
    { name: "Shalom Microfinance Bank", code: "090502" },
    { name: "Shanono MFB", code: "090748" },
    { name: "Shepherd Trust Microfinance BANK", code: "090401" },
    { name: "SHIELD MICROFINANCE BANK LTD", code: "090559" },
    { name: "SHINE MFB", code: "091006" },
    { name: "SHONGOM MICROFINANCE BANK LTD", code: "090558" },
    { name: "Signature Bank", code: "000034" },
    { name: "SIMPLE FINANCE LIMITED", code: "050008" },
    { name: "Simplify Synergy", code: "110034" },
    { name: "SINCERE MFB", code: "090339" },
    { name: "SLS MICROFINANCE BANK", code: "090449" },
    { name: "SmartCash PSB", code: "120004" },
    { name: "SNOW MFB", code: "090573" },
    { name: "SOFRITRUST Microfinance", code: "090435" },
    { name: "Solid Allianze MFB", code: "090506" },
    { name: "Solidrock Microfinance bank", code: "090524" },
    { name: "SOROMAN MFB", code: "090769" },
    { name: "Source Microfinance Bank", code: "090641" },
    { name: "SP", code: "0909806" },
    { name: "Sparkle", code: "090325" },
    { name: "SPECTRUM MICROFINANCE BANK", code: "090436" },
    { name: "SPRING SKY FINANCE", code: "050036" },
    { name: "SPRINGFIELD MICROFINANCE BANK", code: "090806" },
    { name: "SPRINGVILLE MICROFINANCE BANK LIMITED", code: "090786" },
    { name: "Stanbic IBTC @ease wallet", code: "100007" },
    { name: "Stanbic IBTC Bank", code: "000012" },
    { name: "STANDARD CHARTERED BANK NIGERIA LIMITED", code: "000021" },
    { name: "Standard MFB", code: "090182" },
    { name: "STANFORD MFB", code: "090162" },
    { name: "Stateside Microfinance Bank", code: "090583" },
    { name: "STB Mortgage BANK", code: "070022" },
    { name: "STELLAS MICROFINANCE BANK", code: "090262" },
    { name: "Sterling Bank", code: "000001" },
    { name: "STOCKCORP MICROFINANCE BANK", code: "090340" },
    { name: "SULSPAP MFB", code: "090305" },
    { name: "SUMMIT BANK", code: "080003" },
    { name: "Sunbeam Microfinance BANK", code: "090302" },
    { name: "SUNTOP MICROFINANCE BANK", code: "090644" },
    { name: "SUNTRUST BANK", code: "000022" },
    { name: "SUPPORT MICROFINANCE BANK", code: "090446" },
    { name: "SUPREME MICROFINANCE BANK LTD", code: "090564" },
    { name: "SURE ANCHOR MFB", code: "090728" },
    { name: "SWIFT TRUST MFB", code: "090757" },
    { name: "SYCAMORE MFB", code: "090827" },
    { name: "TagPay", code: "100023" },
    { name: "Taj Bank", code: "000026" },
    { name: "TAJ_PINSPAY", code: "080002" },
    { name: "TANADI MICROFINANCE BANK LTD", code: "090560" },
    { name: "Tangale Microfinance Bank", code: "090638" },
    { name: "TASUED MFB", code: "090593" },
    { name: "TATUM BANK", code: "000042" },
    { name: "TeasyMobile", code: "100010" },
    { name: "TEERUS MICROFINANCE BANK", code: "090991" },
    { name: "TEKLA FINANCE", code: "050007" },
    { name: "TELLERONE FI MFB", code: "090788" },
    { name: "TENN MFB", code: "090716" },
    { name: "TF MICROFINANCE BANK", code: "090373" },
    { name: "THE BROOK FINANCE LIMITED", code: "050031" },
    { name: "THRIVE MFB", code: "090283" },
    { name: "TITAN TRUST BANK", code: "000025" },
    { name: "TOPRATE MFB", code: "090801" },
    { name: "TREASURES MFB", code: "090663" },
    { name: "TRIDENT MICROFINANCE BANK", code: "090146" },
    { name: "TRINITY FINANCIAL SERVICES LIMITED", code: "050014" },
    { name: "Triple A Microfinance bank", code: "090525" },
    { name: "TRIVES FINANCE COMPANY LTD", code: "050023" },
    { name: "TRUST MFB", code: "090327" },
    { name: "TRUSTBANC J6 MICROFINANCE BANK LIMITED", code: "090123" },
    { name: "TRUSTBOND", code: "090005" },
    { name: "TRUSTFUND MICROFINANCE BANK", code: "090276" },
    { name: "TUDUN WADA MFB", code: "090870" },
    { name: "TURBO MFB", code: "090606" },
    // Filtered Bank List explicitly matching your live Payrant API Payload
    { name: "Uhuru Microfinance bank", code: "090517" },
    { name: "UKPOR MFB", code: "090820" },
    { name: "Ultimate Microfinance Bank", code: "090776" },
    { name: "Ultrapay Microfinance Bank", code: "090253" },
    { name: "Ummah Microfinance Bank", code: "090609" },
    { name: "Umuchinemere Procredit Microfinance Bank", code: "090514" },
    { name: "UMUCHUKWU MICROFINANCE BANK", code: "090652" },
    { name: "Umunnachi Microfinance Bank", code: "090510" },
    { name: "UMUNRI MFB", code: "090808" },
    { name: "Umyu MFB", code: "090704" },
    { name: "UNAAB MFB", code: "090331" },
    { name: "UNIBADAN MICROFINANCE BANK", code: "090461" },
    { name: "UNIBEN MICROFINANCE BANK", code: "090266" },
    { name: "UNICAL MFB", code: "090193" },
    { name: "Unifund Microfinance Bank", code: "090637" },
    { name: "UNILAG MICROFINANCE BANK", code: "090452" },
    { name: "UNILORIN MICROFINANCE BANK", code: "090341" },
    { name: "Unimaid Microfinance BANK", code: "090464" },
    { name: "Union Bank Of Nigeria", code: "000018" },
    { name: "UNITED BANK FOR AFRICA", code: "000004" },
    { name: "UNITY BANK PLC", code: "000011" },
    { name: "UniUyo Microfinance BANK", code: "090338" },
    { name: "Unlimint Nigeria Limited", code: "110081" },
    { name: "UNN MFB", code: "090251" },
    { name: "UNUBI MFB", code: "090719" },
    { name: "Ure Microfinance Bank", code: "090619" },
    { name: "UTAKO MFB", code: "090773" },
    { name: "UVUOMA MFB", code: "090765" },
    { name: "Uzondu Microfinance Bank", code: "090453" },
    { name: "Vale Finance Limited", code: "050020" },
    { name: "Verdant Microfinance Bank", code: "090474" },
    { name: "VFD MFB", code: "090110" },
    { name: "Victory MFB", code: "090813" },
    { name: "VIRTUE MFB", code: "090150" },
    { name: "VISA MICROFINANCE BANK", code: "090139" },
    { name: "VTNetworks", code: "100012" },
    { name: "WAILA MFB", code: "090829" },
    { name: "WALLET MFB", code: "090805" },
    { name: "WAYA MFB", code: "090590" },
    { name: "WE MICROFINANCE BANK", code: "090989" },
    { name: "Wema Bank", code: "000017" },
    { name: "WESLEY MFB", code: "090699" },
    { name: "WETLAND MFB", code: "090120" },
    { name: "Wetson-Charis MFB", code: "090741" },
    { name: "WHITECRUST FINANCE LTD", code: "050035" },
    { name: "WinView BANK", code: "090419" },
    { name: "WRA MFB", code: "090631" },
    { name: "XPRESS MTS", code: "100041" },
    { name: "Xpresswallet", code: "100040" },
    { name: "XSLNCE MICROFINANCE BANK", code: "090124" },
    { name: "YABO MFB", code: "090994" },
    // Filtered Bank List explicitly matching your live Payrant API Payload
    { name: "ZAIN MFB", code: "090976" },
    { name: "ZEDVANCE FINANCE LIMITED", code: "050019" },
    { name: "Zefa MFB", code: "090747" },
    { name: "Zenith Bank", code: "000015" },
    { name: "ZENITH EASY WALLET", code: "100034" },
    { name: "ZENITH Mobile", code: "100018" },
    { name: "Zikora Microfinance bank", code: "090504" },
    { name: "ZION MICROFINANCE BANK", code: "090384" },
    { name: "Zitra MFB", code: "090718" },
  ];

  // Clear existing options first
  bankSelect.innerHTML =
    '<option value="" disabled selected>Select your bank...</option>';

  // Loop through and add them
  banks.forEach((bank) => {
    const option = document.createElement("option");
    option.value = bank.code;
    option.textContent = bank.name;
    bankSelect.appendChild(option);
  });

  console.log("Banks loaded successfully!");
});

document.addEventListener("DOMContentLoaded", () => {
  // Select all navigation items within your bottom nav track
  const navItems = document.querySelectorAll("#bottomNav .nav-item");

  navItems.forEach((item) => {
    item.addEventListener("click", function (e) {
      // 1. Prevent default jump if the href is just a placeholder "#"
      if (this.getAttribute("href") === "#") {
        e.preventDefault();
      }

      // 2. Remove the 'active' class from whichever item currently has it
      const currentActive = document.querySelector(
        "#bottomNav .nav-item.active",
      );
      if (currentActive) {
        currentActive.classList.remove("active");
      }

      // 3. Apply the electric cyan active state to the clicked element
      this.classList.add("active");
    });
  });
});

document.addEventListener("DOMContentLoaded", () => {
  // Attach to the login button
  const googleLoginBtn = document.getElementById("googleLoginBtn");
  if (googleLoginBtn) {
    googleLoginBtn.addEventListener("click", handleGoogleLogin);
  }

  // Attach to the signup button
  const googleSignupBtn = document.getElementById("googleSignupBtn");
  if (googleSignupBtn) {
    googleSignupBtn.addEventListener("click", handleGoogleLogin);
  }
});
