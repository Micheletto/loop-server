/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

var conf = require("./config").conf;
var loopPackageData = require('../package.json');
var os = require("os");

// Assume the hostname will not change once the server is launched.
var hostname = os.hostname();
var sendError = require("./utils").sendError;
var isoDateString = require("./utils").isoDateString;
var errors = require("./errno.json");
var hekaLogger = require('./logger').hekaLogger;
var logging = require("express-logging");
var time = require('./utils').time;

function handle503(logError) {
  return function UnavailableService(req, res, next) {
    res.serverError = function raiseError(error) {
      if (error) {
        logError(error);
        sendError(res, 503, errors.BACKEND, "Service Unavailable");
        return true;
      }
      return false;
    };

    next();
  };
}

function addHeaders(req, res, next) {
  /* Make sure we don't decorate the writeHead more than one time. */
  if (res._headersMiddleware) {
    next();
    return;
  }

  var writeHead = res.writeHead;
  res._headersMiddleware = true;
  res.writeHead = function headersWriteHead() {
    if (res.statusCode === 200 || res.statusCode === 401) {
      res.setHeader('Timestamp', time());
    }

    if (res.statusCode === 503 || res.statusCode === 429) {
      res.setHeader('Retry-After', conf.get('retryAfter'));
    }
    writeHead.apply(res, arguments);
  };
  next();
}


function logMetrics(req, res, next) {
  if (conf.get('hekaMetrics').activated === true) {
    res.on('finish', function() {
      var ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
      var action;
      if (req.body && req.body.action) {
        action = req.body.action;
      }

      var line = {
        code: res.statusCode,
        path: req.path,
        method: req.method.toLowerCase(),
        query: req.query,
        agent: req.headers['user-agent'],
        time: isoDateString(new Date()),
        uid: req.user,
        callId: req.callId,
        token: req.token,
        v: loopPackageData.version,
        hostname: hostname,
        lang: req.headers["accept-language"],
        ip: ip,
        errno: res.errno || 0,
        action: action
      };

      if (req.hasOwnProperty("callUrlData")) {
        line.calleeId = req.callUrlData.userMac;
        line.callerId = req.user;
      }

      if (req.hasOwnProperty("roomStorageData")) {
        if (req.roomStorageData.hasOwnProperty("participants")) {
          line.participants = req.roomStorageData.participants.length;
        }
      }

      if (req.hasOwnProperty("roomConnectionId")) {
        line.roomConnectionId = req.roomConnectionId;
      }

      if (req.hasOwnProperty("roomParticipantsCount")) {
        line.participants = req.roomParticipantsCount;
      }

      if (res.statusCode === 401) {
        line.authorization = req.headers.authorization;
        line.hawk = req.hawk;
        line.error = res.get("www-authenticate");
      }

      hekaLogger.info('request.summary', line);
    });
  }
  if (conf.get('logRequests').activated === true) {
    logging(conf.get("logRequests").consoleDateFormat)(req, res, next);
  } else {
    next();
  }
}

/**
 * Handle all the uncatched errors.
 * In this case, we want to catch them and return either a 500 or a 400 in case
 * the uncatched error was generated by a previous middleware.
 **/
function handleUncatchedErrors(error, req, res) {
  if (error && error.status === 400) {
    sendError(res, 400, errors.BAD_JSON, error.body);
  } else {
    sendError(res, 500, 999, "" + error);
  }
}

// In case of apiPrefix missing redirect the user to the right URL
// In case of apiPrefix present, raise a 404 error.
function handleRedirects(apiPrefix) {
  return function(req, res) {
    if (req.path.indexOf(apiPrefix) !== 0) {
      res.redirect(307, apiPrefix + req.path);
      return;
    }
    sendError(res, 404, 999, "Resource not found.");
  }
}

module.exports = {
  addHeaders: addHeaders,
  handle503: handle503,
  handleUncatchedErrors: handleUncatchedErrors,
  handleRedirects: handleRedirects,
  hekaLogger: hekaLogger,
  logMetrics: logMetrics
};
