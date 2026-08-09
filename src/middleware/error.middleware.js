// src/middleware/error.middleware.js
function notFound(req, res) {
  res.status(404).json({ status: false, message: 'route_not_found' });
}

function errorHandler(err, req, res, next) {
  console.error(err);
  res.status(err.status || 500).json({
    status: false,
    message: err.message || 'internal_server_error',
  });
}

module.exports = { notFound, errorHandler };
