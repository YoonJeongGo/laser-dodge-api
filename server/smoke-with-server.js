process.env.NODE_ENV ||= "development";
await import("./server.js");

setTimeout(async () => {
  try {
    await import("./smoke-test.js");
    process.exit(0);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}, 1500);
