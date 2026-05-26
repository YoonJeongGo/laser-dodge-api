const base = process.env.API_BASE_URL || "http://127.0.0.1:8787";

const suffix = Math.floor(Math.random() * 100000);

const check = await fetch(`${base}/auth/check?username=tester${suffix}&nickname=Tester${suffix}`).then((res) => res.json());
console.log("CHECK", check);

const registered = await fetch(`${base}/auth/register`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    username: `tester${suffix}`,
    password: "password1",
    nickname: `Tester${suffix}`,
  }),
}).then((res) => res.json());

console.log("REGISTER", registered);

const login = await fetch(`${base}/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username: `tester${suffix}`, password: "password1" }),
}).then((res) => res.json());

const user = login.user;
const token = login.token;
console.log("USER", user);

const me = await fetch(`${base}/auth/me`, {
  headers: { Authorization: `Bearer ${token}` },
}).then((res) => res.json());
console.log("ME", me);

const totalScore = 1672;
const survivalTime = 17.29;
const pScore = 1500;

const score = await fetch(`${base}/scores`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
  body: JSON.stringify({
    total_score: totalScore,
    survival_time: survivalTime,
    p_score: pScore,
  }),
}).then((res) => res.json());

console.log("SCORE", score);

const leaderboard = await fetch(`${base}/leaderboard?limit=5`).then((res) => res.json());
console.log("LEADERBOARD", leaderboard);
