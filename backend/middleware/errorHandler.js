function errorHandler(err, req, res, next) {
console.error("Server Error:", err);

const statusCode = err.statusCode || 500;

res.status(statusCode).json({
error: true,
message:
process.env.NODE_ENV === "production"
? "Something went wrong on the server."
: err.message || "Internal server error."
});
}

module.exports = errorHandler;
