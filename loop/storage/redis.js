/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";
var redis = require("redis");
var async = require("async");
var constants = require("../constants");

var SIMPLE_PUSH_TOPICS = ["calls", "rooms"];

var isUndefined = function(field, fieldName, callback) {
  if (field === undefined) {
    callback(new Error(fieldName + " should not be undefined"));
    return true;
  }
  return false;
}


function RedisStorage(options, settings) {
  this._settings = settings;
  this._client = redis.createClient(
    options.port,
    options.host,
    options.options
  );
  if (options.db) {
    this._client.select(options.db);
  }
}

RedisStorage.prototype = {


  /**
   * Adds a set of simple push urls to an user (one per simple push topic).
   *
   * @param {String}    userHmac, the hmac-ed user, the HMAC of the user;
   * @param {String}    hawkIdHmac, the hmac-ed hawk id of the client;
   * @param {String}    simplePushURLs, an object with a key per SP topic;
   * @param {Function}  A callback that will be called once data had been
   *                    processed.
   **/
  addUserSimplePushURLs: function(userMac, hawkIdHmac, simplePushURLs, callback) {
    if (isUndefined(userMac, "userMac", callback)) return;
    if (isUndefined(hawkIdHmac, "hawkIdHmac", callback)) return;
    var self = this;
    Object.keys(simplePushURLs).forEach(function(topic) {
      if (SIMPLE_PUSH_TOPICS.indexOf(topic) === -1) {
        callback(new Error(topic + " should be one of " +
                           SIMPLE_PUSH_TOPICS.join(", ")));
        return;
      }
    });

    // Remove any previous storage spurl.{userMac} LIST
    // XXX - Bug 1069208 — Remove this two months after 0.13 release
    // (January 2015)
    self._client.del('spurl.' + userMac, function(err) {
      if (err) return callback(err);
      // Manage each session's SP urls in a hash, and maintain a list of sessions
      // with a simple push url per user.
      self._client.hmset('spurls.' + userMac + '.' + hawkIdHmac, simplePushURLs,
        function(err) {
          if (err) return callback(err);
          self._client.sadd('spurls.' + userMac, hawkIdHmac, callback);
        });
    });
  },

  /**
   * Return the simple push URLS for a specified userMac.
   *
   * @param {String}    userMac, the userMac to which the simple push urls had
   *                    been associated;
   * @param {Function}  callback, the callback to call when data had been
   *                    loaded. It will be passed an object with a calls and
   *                    rooms keys, which will each contain a list of simple
   *                    push urls.
   **/
  getUserSimplePushURLs: function(userMac, callback) {
    var self = this;
    if (isUndefined(userMac, "userMac", callback)) return;

    var output = {};
    SIMPLE_PUSH_TOPICS.forEach(function(topic) {
      output[topic] = [];
    });

    // Remove any previous storage spurl.{userHmac} LIST
    // XXX - Bug 1069208 — Remove this two months after 0.13 release
    // (January 2015)
    self._client.lrange(
      'spurl.' + userMac, 0, this._settings.maxSimplePushUrls,
      function(err, SPcallUrls) {
        if (err) return callback(err);
        SPcallUrls.forEach(function(item) {
          if (output.calls.indexOf(item) === -1)
          output.calls.push(item);
        });
        self._client.smembers('spurls.' + userMac, function(err, hawkMacIds) {
          if (err) return callback(err);
          async.map(hawkMacIds, function(hawkMacId, done) {
            self._client.hgetall('spurls.' + userMac + '.' + hawkMacId, done);
          },
          function(err, simplePushMappings) {
            if (err) return callback(err);
            simplePushMappings.forEach(function(mapping) {
              if (mapping) {
                SIMPLE_PUSH_TOPICS.forEach(function(topic) {
                  if (mapping.hasOwnProperty(topic) && output[topic].indexOf(mapping[topic]) === -1) {
                    output[topic].push(mapping[topic]);
                  }
                });
              }
            });
            callback(null, output);
          });
        });
      });
  },


  /**
   * Removes the simple push url of the given user/device.
   *
   * @param {String}         userHmac, the hmac-ed user, the HMAC of the user;
   * @param {String}         hawkIdHmac, the hmac-ed hawk id of the client;
   * @param {Function}       A callback that will be called once data had been
   *                         processed.
   *
   **/
  removeSimplePushURLs: function(userMac, hawkIdHmac, callback) {
    if (isUndefined(userMac, "userMac", callback)) return;
    if (isUndefined(hawkIdHmac, "hawkIdHmac", callback)) return;
    var self = this;
    self._client.srem('spurls.' + userMac, hawkIdHmac, function(err, deleted) {
      if (err) return callback(err);
      if (deleted > 0) {
        self._client.del('spurls.' + userMac + '.' + hawkIdHmac, callback);
      } else {
        callback(null);
      }
    });
  },

  /**
   * Deletes all the simple push URLs of an user.
   *
   * @param {String}         userHmac, the hmac-ed user, the HMAC of the user;
   * @param {Function}       A callback that will be called once data had been
   *                         processed.
   *
   **/
  deleteUserSimplePushURLs: function(userMac, callback) {
    var self = this;
    if (isUndefined(userMac, "userMac", callback)) return;
    this._client.smembers('spurls.' + userMac, function(err, hawkMacIds) {
      if (err) return callback(err);
      async.each(hawkMacIds, function(hawkIdHmac, done) {
        self._client.del('spurls.' + userMac + '.' + hawkIdHmac, done);
      }, function(err) {
        if (err) return callback(err);
        self._client.del('spurls.' + userMac, callback);
      });
    });
  },

  /**
   * Add a new user call url.
   *
   * @param {String}    userMac, the hmac-ed user, the HMAC of the user;
   * @param {String}    callUrlId, the call url token;
   * @param {Mapping}   urlData, the call-url properties;
   * @param {Function}  A callback that will be called once data had been
   *                    processed.
   **/
  addUserCallUrlData: function(userMac, callUrlId, urlData, callback) {
    if (isUndefined(userMac, "userMac", callback)) return;
    if (isUndefined(callUrlId, "callUrlId", callback)) return;
    if (isUndefined(urlData.timestamp, "urlData.timestamp", callback)) return;
    var self = this;

    var data = JSON.parse(JSON.stringify(urlData));
    data.userMac = userMac;

    // In that case use setex to add the metadata of the url.
    this._client.setex(
      'callurl.' + callUrlId,
      urlData.expires - parseInt(Date.now() / 1000, 10),
      JSON.stringify(data),
      function(err) {
        if (err) {
          callback(err);
          return;
        }
        self._client.sadd(
          'userUrls.' + userMac,
          'callurl.' + callUrlId, callback
        );
      });
  },

  /**
   * Update a call-url data.
   *
   * @param {String}    userMac, the hmac-ed user, the HMAC of the user;
   * @param {String}    callUrlId, the call url token;
   * @param {Mapping}   newData, the call-url properties;
   * @param {Function}  A callback that will be called once data had been
   *                    processed.
   *
   **/
  updateUserCallUrlData: function(userMac, callUrlId, newData, callback) {
    var self = this;
    if (isUndefined(userMac, "userMac", callback)) return;
    if (isUndefined(callUrlId, "callUrlId", callback)) return;
    self._client.sismember(
      'userUrls.' + userMac,
      'callurl.' + callUrlId,
      function(err, res) {
        if (err) {
          callback(err);
          return;
        }
        if (res === 0) {
          var error = new Error("Doesn't exist");
          error.notFound = true;
          callback(error);
          return;
        }
        // Get and update the existing data.
        self.getCallUrlData(callUrlId, function(err, data) {
          if (err) {
            callback(err);
            return;
          }
          Object.keys(newData).forEach(function(key) {
            data[key] = newData[key];
          });

          self._client.setex(
            'callurl.' + callUrlId,
            data.expires - parseInt(Date.now() / 1000, 10),
            JSON.stringify(data),
            callback
          );
        });
      }
    );
  },

  /**
   * Get call-url data
   *
   * @param {String}    callUrlId, the call url token;
   * @param {Function}  A callback that will be called once data had been
   *                    processed.
   *
   **/
  getCallUrlData: function(callUrlId, callback) {
    if (isUndefined(callUrlId, "callUrlId", callback)) return;
    this._client.get('callurl.' + callUrlId, function(err, data) {
      if (err) {
        callback(err);
        return;
      }
      callback(null, JSON.parse(data));
    });
  },

  /**
   * Deletes all the call-url data for a given user.
   *
   * Deletes the list of call-urls and all the call-url data for each call.
   *
   * @param {String}    userMac, the hmac-ed user, the HMAC of the user;
   * @param {Function}  A callback that will be called once data had been
   *                    processed.
   **/
  deleteUserCallUrls: function(userMac, callback) {
    var self = this;
    if (isUndefined(userMac, "userMac", callback)) return;
    self._client.smembers('userUrls.' + userMac, function(err, calls) {
      if (err) {
        callback(err);
        return;
      }
      self._client.del(calls, function(err) {
        if (err) {
          callback(err);
          return;
        }
        self._client.del('userUrls.' + userMac, callback);
      });
    });
  },

  /**
   * Revoke the call-url token.
   *
   * @param {String}    callUrlId, the call url token;
   * @param {Function}  A callback that will be called once data had been
   *                    processed.
   **/
  revokeURLToken: function(callUrlId, callback) {
    if (isUndefined(callUrlId, "callUrlId", callback)) return;
    this._client.del('callurl.' + callUrlId, callback);
  },

  /**
   * Get the user's call urls
   *
   * @param {String}    userMac, the hmac-ed user, the HMAC of the user;
   * @param {Function}  A callback that will be called once data had been
   *                    processed.
   **/
  getUserCallUrls: function(userMac, callback) {
    var self = this;
    if (isUndefined(userMac, "userMac", callback)) return;
    this._client.smembers('userUrls.' + userMac, function(err, members) {
      if (err) {
        callback(err);
        return;
      }

      if (members.length === 0) {
        callback(null, []);
        return;
      }
      self._client.mget(members, function(err, urls) {
        if (err) {
          callback(err);
          return;
        }
        var expired = urls.map(function(url, index) {
          return (url === null) ? index : null;
        }).filter(function(url) {
          return url !== null;
        });

        var pendingUrls = urls.filter(function(url) {
          return url !== null;
        }).map(JSON.parse).sort(function(a, b) {
          return a.timestamp - b.timestamp;
        });

        if (expired.length > 0) {
          self._client.srem('userUrls.' + userMac, expired, function(err) {
            if (err) {
              callback(err);
              return;
            }
            callback(null, pendingUrls);
          });
          return;
        }
        callback(null, pendingUrls);
      });
    });
  },

  /**
   * Starts a call.
   *
   * @param {String}    userMac, the hmac-ed user, the HMAC of the user;
   * @param {Mapping}   call, the call properties to be stored;
   * @param {Function}  A callback that will be called once data had been
   *                    processed.
   **/
  addUserCall: function(userMac, call, callback) {
    if (isUndefined(userMac, "userMac", callback)) return;
    var self = this;
    // Clone the args to prevent from modifying it.
    call = JSON.parse(JSON.stringify(call));
    var state = call.callState;
    delete call.callState;
    this._client.setex(
      'call.' + call.callId,
      this._settings.callDuration,
      JSON.stringify(call),
      function(err) {
        if (err) {
          callback(err);
          return;
        }
        self.setCallState(call.callId, state, function(err) {
          if (err) {
            callback(err);
            return;
          }
          self._client.sadd('userCalls.' + userMac,
                            'call.' + call.callId, callback);
        });
      });
  },

  /**
   * Deletes all the call of a given user.
   *
   * @param {String}    userMac, the hmac-ed user, the HMAC of the user;
   * @param {Function}  A callback that will be called once data had been
   *                    processed.
   **/
  deleteUserCalls: function(userMac, callback) {
    if (isUndefined(userMac, "userMac", callback)) return;
    var self = this;
    this._client.smembers('userCalls.' + userMac, function(err, members) {
      if (err) {
        callback(err);
        return;
      }
      if (members.length === 0) {
        callback(null);
        return;
      }
      self._client.mget(members, function(err, calls) {
        if (err) {
          callback(err);
          return;
        }
        self._client.del(members, function(err) {
          if (err) {
            callback(err);
            return;
          }
          async.map(calls.map(JSON.parse), function(call, cb) {
            self._client.del('callstate.' + call.callId, cb);
          }, function(err) {
            if (err) {
              callback(err);
              return;
            }
            self._client.del('userCalls.' + userMac, callback);
          });
        });
      });
    });
  },

  /**
   * Get the user calls list.
   *
   * @param {String}    userMac, the hmac-ed user, the HMAC of the user;
   * @param {Function}  A callback that will be called once data had been
   *                    processed.
   **/
  getUserCalls: function(userMac, callback) {
    if (isUndefined(userMac, "userMac", callback)) return;
    var self = this;
    this._client.smembers('userCalls.' + userMac, function(err, members) {
      if (err) {
        callback(err);
        return;
      }

      if (members.length === 0) {
        callback(null, []);
        return;
      }
      self._client.mget(members, function(err, calls) {
        if (err) {
          callback(err);
          return;
        }
        var expired = calls.map(function(call, index) {
          return (call === null) ? index : null;
        }).filter(function(call) {
          return call !== null;
        });

        var pendingCalls = calls.filter(function(call) {
          return call !== null;
        }).map(JSON.parse).sort(function(a, b) {
          return a.timestamp - b.timestamp;
        });

        function getState() {
          async.map(pendingCalls, function(call, cb) {
            self.getCallState(call.callId, function(err, state) {
              if (err) {
                cb(err);
                return;
              }
              call.callState = state;
              cb(null, call);
            });
          }, function(err, results) {
            if (err) {
              callback(err);
              return;
            }
            callback(null, results);
          });
        }

        if (expired.length > 0) {
          self._client.srem('userCalls.' + userMac, expired, function(err) {
            if (err) {
              callback(err);
              return;
            }
            getState();
          });
          return;
        }
        getState();
      });
    });
  },

  /**
   * Returns the expiricy of the call state (in seconds).
   * In case the call is already expired, returns -1.
   *
   * @param {String}    callId, the call id;
   * @param {Function} A callback that will be called once the action
   *                    had been processed.
   **/
  getCallStateTTL: function(callId, callback) {
    if (isUndefined(callId, "callId", callback)) return;
    this._client.pttl('callstate.' + callId, function(err, ttl) {
      if (err) {
        callback(err);
        return;
      }
      if (ttl <= 1) {
        ttl = -1;
      } else {
        ttl = ttl / 1000;
      }
      callback(null, ttl);
    });
  },

  /**
   * Sets the call state to the given state.
   *
   * In case no TTL is given, fetches the one of the call so the expiration
   * is the same for the call and for its state.
   *
   * @param {String}    callId, the call id;
   * @param {String}    state, the state;
   * @param {Integer}   ttl, Number of seconds we want to store this state.
   * @param {Function}  A callback that will be called once the action
   *                    had been processed.
   **/
  setCallState: function(callId, state, ttl, callback) {
    if (isUndefined(callId, "callId", callback)) return;
    var self = this;

    // In case we don't have a TTL, get the one from the call.
    if (ttl === undefined || callback === undefined) {
      if (callback === undefined) callback = ttl;
      this._client.ttl('call.' + callId, function(err, res) {
        if (err) {
          callback(err);
          return;
        }
        self.setCallState(callId, state, res, callback);
      });
      return;
    }

    var validStates = [
      constants.CALL_STATES.INIT,
      constants.CALL_STATES.INIT + ".caller",
      constants.CALL_STATES.INIT + ".callee",
      constants.CALL_STATES.CONNECTING,
      constants.CALL_STATES.CONNECTED + ".caller",
      constants.CALL_STATES.CONNECTED + ".callee",
      constants.CALL_STATES.TERMINATED
    ];

    if (validStates.indexOf(state) === -1) {
      callback(
        new Error(state + " should be one of " + validStates.join(", "))
      );
      return;
    }

    var key = 'callstate.' + callId;

    if(state === constants.CALL_STATES.TERMINATED) {
      self._client.del(key, callback);
      return;
    }

    // Internally, this uses a redis set to be sure we don't store twice the
    // same call state.
    self._client.sadd(key, state, function(err) {
      if (err) {
        callback(err);
        return;
      }
      self._client.pexpire(key, ttl * 1000, callback);
    });
  },

  /**
   * Gets the state of a call.
   *
   * Returns one of "init", "half-initiated", "alerting", "connecting",
   * "half-connected" and "connected".
   *
   * @param {String}    callId, the call id;
   * @param {Function}  A callback that will be called once the action
   *                    had been processed.
   **/
  getCallState: function(callId, callback) {
    if (isUndefined(callId, "callId", callback)) return;
    var self = this;

    // Get the state of a given call. Because of how we store this information
    // (in a redis set), count the number of elements in the set to know what
    // the current state is.
    // State can be (in order) init, alerting, connecting, half-connected,
    // connected. In case of terminate, nothing is stored in the database (the
    // key is dropped).
    self._client.scard('callstate.' + callId, function(err, score) {
      if (err) {
        callback(err);
        return;
      }
      switch (score) {
      case 1:
        callback(null, constants.CALL_STATES.INIT);
        break;
      case 2:
        callback(null, constants.CALL_STATES.HALF_INITIATED);
        break;
      case 3:
        callback(null, constants.CALL_STATES.ALERTING);
        break;
      case 4:
        callback(null, constants.CALL_STATES.CONNECTING);
        break;
      case 5:
        callback(null, constants.CALL_STATES.HALF_CONNECTED);
        break;
      case 6:
        callback(null, constants.CALL_STATES.CONNECTED);
        break;
      default:
        // Ensure a call exists if nothing is stored on this key.
        self.getCall(callId, false, function(err, result) {
          if (err) {
            callback(err);
            return;
          }
          if (result !== null) {
            callback(null, constants.CALL_STATES.TERMINATED);
            return;
          }
          callback(null, null);
        });
      }
    });
  },

  /**
   * Increments the number of connected devices for this call.
   *
   * @param {String}    type, callee or caller;
   * @param {String}    callId, the call id;
   * @param {Function}  A callback that will be called once the action
   *                    had been processed.
   **/
  incrementConnectedCallDevices: function(type, callId, callback) {
    var self = this;
    if (isUndefined(callId, "callId", callback)) return;
    if (isUndefined(type, "type", callback)) return;
    var key = 'call.devices.' + callId + '.' + type;

    self._client.incr(key, function(err) {
      if (err) {
        return callback(err);
      }
      self._client.expire(key, self._settings.callDuration, callback);
    });
  },

  /**
   * Decrement the number of connected devices for this call.
   *
   * @param {String}    type, callee or caller;
   * @param {String}    callId, the call id;
   * @param {Function}  A callback that will be called once the action
   *                    had been processed.
   **/
  decrementConnectedCallDevices: function(type, callId, callback) {
    var self = this;
    if (isUndefined(callId, "callId", callback)) return;
    if (isUndefined(type, "type", callback)) return;
    var key = 'call.devices.' + callId + '.' + type;

    self._client.decr(key, function(err) {
      if (err) {
        return callback(err);
      }
      self._client.expire(key, self._settings.callDuration, callback);
    });
  },

  /**
   * Return the number of connected devices for this call.
   *
   * @param {String}    type, callee or caller;
   * @param {String}    callId, the call id;
   * @param {Function}  A callback that will be called once the action
   *                    had been processed.
   **/
  getConnectedCallDevices: function(type, callId, callback) {
    var self = this;
    if (isUndefined(callId, "callId", callback)) return;
    if (isUndefined(type, "type", callback)) return;
    var key = 'call.devices.' + callId + '.' + type;

    self._client.get(key, function(err, number) {
      if (err) {
        return callback(err);
      }
      return callback(err, parseInt(number));
    });
  },

  /**
   * Set the call termination reason.
   *
   * @param {String}    callId, the call id;
   * @param {String}    reason, the reason why the call has been terminated;
   * @param {Function}  A callback that will be called once the action
   *                    had been processed.
   **/
  setCallTerminationReason: function(callId, reason, callback) {
    var self = this;
    if (isUndefined(callId, "callId", callback)) return;

    if (reason === undefined) {
      callback(null);
      return;
    }
    self._client.ttl('call.' + callId, function(err, ttl) {
      if (err) {
        callback(err);
        return;
      }
      self._client.setex('callStateReason.' + callId, ttl, reason, callback);
    });
  },

  /**
   * Get the call termination reason.
   *
   * @param {String}    callId, the call id;
   * @param {Function}  A callback that will be called with the reason.
   **/
  getCallTerminationReason: function(callId, callback) {
    if (isUndefined(callId, "callId", callback)) return;
    this._client.get('callStateReason.' + callId, callback);
  },

  /**
   * Get a call from its id.
   *
   * By default, returns the state of the call. You can set getState to false
   * to deactivate this behaviour.
   *
   * @param {String}    callId, the call id;
   * @param {Boolean}   getState, if getState is set to false, don't get the state;
   * @param {Function}  A callback that will be called with the call.
   **/
  getCall: function(callId, getState, callback) {
    if (callback === undefined) {
      callback = getState;
      getState = true;
    }
    if (isUndefined(callId, "callId", callback)) return;

    var self = this;
    this._client.get('call.' + callId, function(err, data) {
      if (err) {
        callback(err);
        return;
      }
      var call = JSON.parse(data);
      if (call !== null && getState === true) {
        self.getCallState(callId, function(err, state) {
          if (err) {
            callback(err);
            return;
          }
          call.callState = state;
          callback(err, call);
        });
        return;
      }
      callback(err, call);
    });
  },

  /**
   * Delete call.
   *
   * Delete a call from its id.
   *
   * @param {String}   callId, the call id;
   * @param {Function} A callback that will be called when the action
   *                   has been processed.
   **/
  deleteCall: function(callId, callback) {
    if (isUndefined(callId, "callId", callback)) return;

    this._client.del('call.' + callId, function(err, result) {
      if (err) {
        callback(err);
        return;
      }
      callback(null, result !== 0);
    });
  },

  /**
   * Add an hawk id to the list of valid hawk ids for an user.
   *
   * @param {String}   userMac, the user Hmac;
   * @param {String}   hawkIdHmac, the hmac-ed hawk id of the client;
   * @param {Function} A callback that will be called when the action
   *                   has been processed.
   **/
  setHawkUser: function(userMac, hawkIdHmac, callback) {
    if (isUndefined(userMac, "userMac", callback)) return;
    if (isUndefined(hawkIdHmac, "hawkIdHmac", callback)) return;

    this._client.setex(
      'hawkuser.' + hawkIdHmac,
      this._settings.hawkSessionDuration,
      userMac,
      callback
    );
  },

  /**
   * Get the Hawk user from an Hawk ID.
   *
   * @param {String}   hawkIdHmac, the hmac-ed hawk id of the client;
   * @param {Function} A callback that will be called when the action
   *                   has been processed.
   **/
  getHawkUser: function(hawkIdHmac, callback) {
    if (isUndefined(hawkIdHmac, "hawkIdHmac", callback)) return;

    this._client.get('hawkuser.' + hawkIdHmac, callback);
  },

  /**
   * Associates an hawk.id (hmac-ed) to an user identifier (encrypted).
   *
   * @param {String}   hawkIdHmac, the hmac-ed hawk id of the client;
   * @param {String}   encryptedUserId, user id encrypted with the HawkId;
   * @param {Function} A callback that will be called when the action
   *                   has been processed.
   **/
  setHawkUserId: function(hawkIdHmac, encryptedUserId, callback) {
    if (isUndefined(hawkIdHmac, "hawkIdHmac", callback)) return;
    if (isUndefined(encryptedUserId, "encryptedUserId", callback)) return;
    this._client.setex(
      'userid.' + hawkIdHmac,
      this._settings.hawkSessionDuration,
      encryptedUserId,
      callback
    );
  },

  /**
   * Get the encrypted User Id.
   *
   * @param {String}   hawkIdHmac, the hmac-ed hawk id of the client;
   * @param {Function} A callback that will be called with the encrypted user id.
   **/
  getHawkUserId: function(hawkIdHmac, callback) {
    if (isUndefined(hawkIdHmac, "hawkIdHmac", callback)) return;
    this._client.get('userid.' + hawkIdHmac, callback);
  },

  /**
   * Delete the encrypted user id.
   *
   * @param {String}   hawkIdHmac, the hmac-ed hawk id of the client;
   * @param {Function} A callback that will be called with the encrypted user id.
   **/
  deleteHawkUserId: function(hawkIdHmac, callback) {
    if (isUndefined(hawkIdHmac, "hawkIdHmac", callback)) return;
    this._client.del('userid.' + hawkIdHmac, callback);
  },

  /**
   * Set the Hawk Session private key.
   *
   * @param {String}   hawkIdHmac, the hmac-ed hawk id of the client;
   * @param {String}   authKey, the Hawk auth Key;
   * @param {Function} A callback that will be called when the action
   *                   has been processed.
   **/
  setHawkSession: function(hawkIdHmac, authKey, callback) {
    if (isUndefined(hawkIdHmac, "hawkIdHmac", callback)) return;
    if (isUndefined(authKey, "authKey", callback)) return;
    this._client.setex(
      'hawk.' + hawkIdHmac,
      this._settings.hawkSessionDuration,
      authKey,
      callback
    );
  },

  /**
   * Update the session time to live.
   *
   * @param {String}   hawkIdHmac, the hmac-ed hawk id of the client;
   * @param {Function} A callback that will be called when the action
   *                   has been processed.
   **/
  touchHawkSession: function(hawkIdHmac, callback) {
    if (isUndefined(hawkIdHmac, "hawkIdHmac", callback)) return;

    var self = this;
    self._client.expire(
      'userid.' + hawkIdHmac,
      self._settings.hawkSessionDuration,
      function(err) {
        if (err) {
          callback(err);
          return;
        }
        self._client.expire(
          'hawk.' + hawkIdHmac,
          self._settings.hawkSessionDuration,
          callback
        );
      });
  },

  /**
   * Return the Auth Key for the following session.
   *
   * @param {String}   hawkIdHmac, the hmac-ed hawk id of the client;
   * @param {Function} A callback that will be called when the action
   *                   has been processed.
   **/
  getHawkSession: function(hawkIdHmac, callback) {
    if (isUndefined(hawkIdHmac, "hawkIdHmac", callback)) return;

    this._client.get('hawk.' + hawkIdHmac, function(err, key) {
      if (err) {
        callback(err);
        return;
      }

      var data = {
        key: key,
        algorithm: "sha256"
      };

      callback(null, key === null ? null : data);
    });
  },

  /**
   * Remove the Hawk Session.
   *
   * @param {String}   hawkIdHmac, the hmac-ed hawk id of the client;
   * @param {Function} A callback that will be called when the action
   *                   has been processed.
   **/
  deleteHawkSession: function(hawkIdHmac, callback) {
    if (isUndefined(hawkIdHmac, "hawkIdHmac", callback)) return;
    this._client.del('hawk.' + hawkIdHmac, callback);
  },

  /**
   * Set the Hawk OAuth token.
   *
   * @param {String}   hawkIdHmac, the hmac-ed hawk id of the client;
   * @param {String}   token, the FxA oauth token;
   * @param {Function} A callback that will be called when the action
   *                   has been processed.
   **/
  setHawkOAuthToken: function(hawkIdHmac, token, callback) {
    if (isUndefined(hawkIdHmac, "hawkIdHmac", callback)) return;
    this._client.set('oauth.token.' + hawkIdHmac, token, callback);
  },

  /**
   * Get the Hawk OAuth token
   *
   * @param {String}   hawkIdHmac, the hmac-ed hawk id of the client;
   * @param {Function} A callback that will be called when the action
   *                   has been processed and returns the token.
   **/
  getHawkOAuthToken: function(hawkIdHmac, callback) {
    if (isUndefined(hawkIdHmac, "hawkIdHmac", callback)) return;
    this._client.get('oauth.token.' + hawkIdHmac, callback);
  },

  /**
   * Set the Hawk OAuth state
   *
   * @param {String}   hawkIdHmac, the hmac-ed hawk id of the client;
   * @param {String}   state, the state given by the FxA;
   * @param {Function} A callback that will be called when the action
   *                   has been processed.
   **/
  setHawkOAuthState: function(hawkIdHmac, state, callback) {
    if (isUndefined(hawkIdHmac, "hawkIdHmac", callback)) return;
    this._client.setex(
      'oauth.state.' + hawkIdHmac,
      this._settings.hawkSessionDuration,
      state,
      callback
    );
  },

  /**
   * Returns the Hawk OAuth state
   *
   * @param {String}   hawkIdHmac, the hmac-ed hawk id of the client;
   * @param {Function} A callback that will be called when the action
   *                   has been processed and returns the state.
   **/
  getHawkOAuthState: function(hawkIdHmac, callback) {
    if (isUndefined(hawkIdHmac, "hawkIdHmac", callback)) return;
    this._client.get('oauth.state.' + hawkIdHmac, callback);
  },

  /**
   * Delete the Hawk OAuth state
   *
   * @param {String}   hawkIdHmac, the hmac-ed hawk id of the client;
   * @param {Function} A callback that will be called when the action
   *                   has been processed.
   **/
  clearHawkOAuthState: function(hawkIdHmac, callback) {
    if (isUndefined(hawkIdHmac, "hawkIdHmac", callback)) return;
    this._client.del('oauth.state.' + hawkIdHmac, callback);
  },

  /**
   * Set the User Room Data
   *
   * @param {String}   userMac, the user Hmac;
   * @param {String}   roomToken, the room identifier;
   * @param {String}   roomData, the room properties;
   * @param {Function} A callback that will be called when the action
   *                   has been processed.
   **/
  setUserRoomData: function(userMac, roomToken, roomData, callback) {
    if (isUndefined(userMac, "userMac", callback)) return;
    if (isUndefined(roomToken, "roomToken", callback)) return;
    if (isUndefined(roomData.expiresAt, "roomData.expiresAt", callback)) return;
    if (isUndefined(roomData.updateTime, "roomData.updateTime", callback)) return;

    var data = JSON.parse(JSON.stringify(roomData));
    data.roomToken = roomToken;
    var self = this;
    // In that case use setex to add the metadata of the url.
    this._client.setex(
      'room.' + roomToken,
      data.expiresAt - data.updateTime,
      JSON.stringify(data),
      function(err) {
        if (err) {
          callback(err);
          return;
        }
        self._client.sadd(
          'userRooms.' + userMac,
          'room.' + roomToken, callback
        );
      });
  },

  /**
   * Get the list of user rooms.
   *
   * @param {String}   userMac, the user Hmac;
   * @param {Function} A callback that will be called when the action
   *                   has been processed and returns the rooms list.
   **/
  getUserRooms: function(userMac, callback) {
    if (isUndefined(userMac, "userMac", callback)) return;
    var self = this;
    this._client.smembers('userRooms.' + userMac, function(err, members) {
      if (err) {
        callback(err);
        return;
      }

      if (members.length === 0) {
        callback(null, []);
        return;
      }
      self._client.mget(members, function(err, rooms) {
        if (err) {
          callback(err);
          return;
        }
        var expired = rooms.map(function(room, index) {
          return (room === null) ? index : null;
        }).filter(function(room) {
          return room !== null;
        });

        var pendingRooms = rooms.filter(function(room) {
          return room !== null;
        }).map(JSON.parse).sort(function(a, b) {
          return a.updateTime - b.updateTime;
        });

        if (expired.length > 0) {
          self._client.srem('userRooms.' + userMac, expired, function(err) {
            if (err) {
              callback(err);
              return;
            }
            callback(null, pendingRooms);
          });
          return;
        }
        callback(null, pendingRooms);
      });
    });
  },

  /**
   * Get the room properties
   *
   * @param {String}   roomToken, the room identifier;
   * @param {Function} A callback that will be called when the action
   *                   has been processed and returns the room properties.
   **/
  getRoomData: function(roomToken, callback) {
    if (isUndefined(roomToken, "roomToken", callback)) return;
    this._client.get('room.' + roomToken, function(err, data) {
      if (err) {
        callback(err);
        return;
      }
      callback(null, JSON.parse(data));
    });
  },

  /**
   * Update the room time to live.
   *
   * @param {String}   roomToken, the room identifier;
   * @param {Function} A callback that will be called when the action
   *                   has been processed.
   **/
  touchRoomData: function(roomToken, callback) {
    if (isUndefined(roomToken, "roomToken", callback)) return;
    var self = this;
    self.getRoomData(roomToken, function(err, data) {
      if (err) {
        callback(err);
        return;
      }
      data.updateTime = parseInt(Date.now() / 1000, 10);
      self._client.setex(
        'room.' + roomToken,
        data.expiresAt - data.updateTime,
        JSON.stringify(data),
        function(err) {
          callback(err, data.updateTime);
        });
    });
  },

  /**
   * Delete the room.
   *
   * @param {String}   roomToken, the room identifier;
   * @param {Function} A callback that will be called when the action
   *                   has been processed.
   **/
  deleteRoomData: function(roomToken, callback) {
    if (isUndefined(roomToken, "roomToken", callback)) return;
    var self = this;
    self.getRoomData(roomToken, function(err, data) {
      if (err) {
        callback(err);
        return;
      }
      self._client.del('room.' + roomToken, function(err) {
        if (err) {
          callback(err);
          return;
        }
        self.deleteRoomParticipants(roomToken, function(err) {
          if (err) {
            callback(err);
            return;
          }
          self._client.hsetnx(
            'room.deleted.' + data.roomOwnerHmac,
            roomToken, parseInt(Date.now() / 1000, 10),
            function(err) {
              if (err) {
                callback(err);
                return;
              }
              self._client.expire(
                'room.deleted.' + data.roomOwnerHmac,
                self._settings.roomsDeletedTTL,
                callback
              );
            });
        });
      });
    });
  },

  getUserDeletedRooms: function(userMac, now, callback) {
    var self = this;
    var expireTime = parseInt(Date.now() / 1000, 10) - self._settings.roomsDeletedTTL;
    if (callback === undefined) {
      callback = now;
      now = undefined;
    }
    if (!now) {
      now = expireTime;
    }
    self._client.hgetall('room.deleted.' + userMac, function(err, deletedRooms) {
      if (err) {
        callback(err);
        return;
      }
      if (deletedRooms) {
        var deleted = Object.keys(deletedRooms).filter(function(roomToken) {
          return deletedRooms[roomToken] >= now;
        });
        var expired = Object.keys(deletedRooms).filter(function(roomToken) {
          return deletedRooms[roomToken] < expireTime;
        });
        if (expired.length > 0) {
          self._client.hdel('room.deleted.' + userMac, expired, function(err) {
            callback(err, deleted);
          });
          return;
        }
        callback(null, deleted);
        return;
      }
      callback(null, []);
    });
  },

  /**
   * Delete the room participants
   *
   * @param {String}   roomToken, the room identifier;
   * @param {Function} A callback that will be called when the action
   *                   has been processed.
   **/
  deleteRoomParticipants: function(roomToken, callback) {
    if (isUndefined(roomToken, "roomToken", callback)) return;
    var self = this;
    self._client.del('roomparticipants.' + roomToken, callback);
  },

  /**
   * Add a participant to the room.
   *
   * @param {String}   roomToken, the room identifier;
   * @param {String}   hawkIdHmac, the hmac-ed hawk id of the client;
   * @param {Function} A callback that will be called when the action
   *                   has been processed.
   **/
  addRoomParticipant: function(roomToken, hawkIdHmac, participantData, ttl,
                               callback) {
    if (isUndefined(roomToken, "roomToken", callback)) return;
    if (isUndefined(hawkIdHmac, "hawkIdHmac", callback)) return;

    var data = JSON.parse(JSON.stringify(participantData));
    data.hawkIdHmac = hawkIdHmac;
    data.expiresAt = parseInt(Date.now() / 1000, 10) + ttl;

    this._client.hset('roomparticipants.' + roomToken, hawkIdHmac,
                      JSON.stringify(data), callback);
  },

  /**
   * Update the participant time to live.
   *
   * @param {String}   roomToken, the room identifier;
   * @param {String}   hawkIdHmac, the hmac-ed hawk id of the client;
   * @param {Integer}  ttl, the new time-to-live;
   * @param {Function} A callback that will be called when the action
   *                   has been processed.
   **/
  touchRoomParticipant: function(roomToken, hawkIdHmac, ttl, callback) {
    if (isUndefined(roomToken, "roomToken", callback)) return;
    if (isUndefined(hawkIdHmac, "hawkIdHmac", callback)) return;
    var self = this;
    var now = parseInt(Date.now() / 1000);
    self._client.hget('roomparticipants.' + roomToken, hawkIdHmac, function(err, data) {
      if (err) {
        callback(err);
        return;
      }
      if (data === null) {
        callback(null, false);
        return;
      }

      data = JSON.parse(data);

      if (data.expiresAt > now) {
        data.expiresAt = parseInt(now + ttl, 10);
        var multi = self._client.multi();
        multi.hset('roomparticipants.' + roomToken, hawkIdHmac, JSON.stringify(data));
        multi.pexpire('roomparticipant_access_token.' + roomToken + '.' + hawkIdHmac,
                      ttl * 1000);
        multi.exec(function(err) {
          callback(err, true);
        });
        return;
      }
      callback(null, false);
    });
  },

  /**
   * Delete the room participant.
   *
   * @param {String}   roomToken, the room identifier;
   * @param {String}   hawkIdHmac, the hmac-ed hawk id of the client;
   * @param {Function} A callback that will be called when the action
   *                   has been processed.
   **/
  deleteRoomParticipant: function(roomToken, hawkIdHmac, callback) {
    if (isUndefined(roomToken, "roomToken", callback)) return;
    if (isUndefined(hawkIdHmac, "hawkIdHmac", callback)) return;
    var multi = this._client.multi();
    multi.hdel('roomparticipants.' + roomToken, hawkIdHmac);
    multi.del('roomparticipant_access_token.' + roomToken + '.' + hawkIdHmac);
    multi.exec(callback);
  },

  /**
   * Get the list of participants.
   *
   * @param {String}   roomToken, the room identifier;
   * @param {Function} A callback that will be called when the action
   *                   has been processed and returns the room participant list.
   **/
  getRoomParticipants: function(roomToken, callback) {
    if (isUndefined(roomToken, "roomToken", callback)) return;

    var self = this;
    var now = parseInt(Date.now() / 1000, 10);
    self._client.hgetall('roomparticipants.' + roomToken,
      function(err, participantsMapping) {
        if (err) {
          callback(err);
          return;
        }
        if (participantsMapping === null) {
          callback(null, []);
          return;
        }

        var participantsKeys = Object.keys(participantsMapping);
        if (participantsKeys.length === 0) {
          callback(null, []);
          return;
        }
        var participants = participantsKeys.map(function(key) {
          return JSON.parse(participantsMapping[key]);
        }).filter(function(participant) {
          return participant.expiresAt > now;
        }).map(function(participant) {
          delete participant.expiresAt;
          return participant;
        });
        callback(null, participants);
      });
  },

  /**
   * Set the anonymous participant access token.
   *
   * @param {String}   roomToken, the room identifier;
   * @param {String}   sessionTokenHmac, the participant identifier;
   * @param {Function} A callback that will be called when the action
   *                   has been processed.
   **/
  setRoomAccessToken: function(roomToken, sessionTokenHmac, ttl, callback) {
    if (isUndefined(roomToken, "roomToken", callback)) return;
    if (isUndefined(sessionTokenHmac, "sessionTokenHmac", callback)) return;

    this._client.psetex(
      'roomparticipant_access_token.' + roomToken + '.' + sessionTokenHmac,
      parseInt(ttl * 1000, 10), "", callback);
  },

  /**
   * Test the anonymous participant access token validity.
   *
   * @param {String}   roomToken, the room identifier;
   * @param {Function} A callback that will be called when the action
   *                   has been processed and return a boolean that
   *                   tells if the token is still valid.
   **/
  isRoomAccessTokenValid: function(roomToken, sessionTokenHmac, callback) {
    if (isUndefined(roomToken, "roomToken", callback)) return;
    if (isUndefined(sessionTokenHmac, "sessionTokenHmac", callback)) return;

    this._client.get(
      'roomparticipant_access_token.' + roomToken + '.' + sessionTokenHmac,
      function(err, data) {
        if (err) {
          callback(err);
          return;
        }
        callback(null, data === "");
      });
  },

  /**
   * Drop the database.
   *
   * @param {Function} A callback that will be called when the action
   *                   has been processed .
   **/
  drop: function(callback) {
    this._client.flushdb(callback);
  },

  /**
   * Ping the database and test that the database is ready to be used.
   *
   * @param {Function} A callback that will be called when the action
   *                   has been processed and return a boolean with the DB status.
   **/
  ping: function(callback) {
    var self = this;
    self._client.set('heartbeat', parseInt(Date.now() / 1000, 10),
      function(err) {
        if (err) {
          callback(false);
          return;
        }
        callback(true);
      });
  }
};

module.exports = RedisStorage;
