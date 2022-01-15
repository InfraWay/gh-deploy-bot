const {
  createNodeMiddleware,
  createProbot,
} = require('probot');

const app = require('../../../index');
const probot = createProbot();

module.exports = createNodeMiddleware(app, {
  probot, webhooksPath: '/api/github/webhooks',
});
