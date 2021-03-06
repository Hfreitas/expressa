const randomstring = require('randomstring')
const jwt = require('jsonwebtoken')
const {v4} = require('uuid')
const debug = require('debug')('expressa')
const crypto = require('crypto')
const pg = require('pg')
const pgPools = {}

exports.orderBy = function (data, orderby) {
  data.sort(function compare (a, b) {
    for (let i = 0; i < orderby.length; i++) {
      const ordering = orderby[i]
      const key = ordering[0]
      if (exports.getPath(a, key) > exports.getPath(b, key)) {
        return ordering[1]
      } else if (exports.getPath(a, key) < exports.getPath(b, key)) {
        return -ordering[1]
      }
    }
    return 0
  })
  return data
}

exports.normalizeOrderBy = function(orderby) {
  if (Array.isArray(orderby)) {
    orderby = orderby.map(function (ordering) {
      if (typeof ordering === 'string') {
        return [ordering, 1]
      } else if (Array.isArray(ordering)) {
        if (ordering.length === 1) {
          return [ordering[0], 1] // add 1 (default to ascending sort)
        }
      }
      return ordering
    })
  } else if (typeof orderby === 'object') {
    const arr = []
    for (const key in orderby) {
      arr.push([key, orderby[key]])
    }
    orderby = arr
  } else {
    throw exports.ApiError(400, 'orderby param must be array or object')
  }
  return orderby
}

exports.getPath = (obj, path, defaultValue) => {
  const result = String.prototype.split.call(path, /[,[\].]+?/)
    .filter(Boolean)
    .reduce((res, key) => (res !== null && res !== undefined) ? res[key] : res, obj)
  return (result === undefined || result === obj) ? defaultValue : result
}

exports.castArray = function(arr) {
  return Array.isArray(arr) ? arr : [arr]
}

exports.clone = function (obj) {
  if (!obj) {
    return obj
  }
  return JSON.parse(JSON.stringify(obj))
}

exports.createSecureRandomId = function() {
  return crypto.randomBytes(24).toString('hex')
}

exports.getUserWithPermissions = async function (api, permissions) {
  if (typeof permissions === 'string') {
    permissions = [permissions]
  }
  permissions = permissions || []
  const permissionsMap = {}
  permissions.forEach(function (permission) {
    permissionsMap[permission] = true
  })
  const randId = randomstring.generate(12)
  const roleName = 'role' + randId
  const user = {
    email: 'test' + randId + '@example.com',
    password: '123',
    roles: [roleName]
  }
  await api.db.role.cache.create({
    _id: roleName,
    permissions: permissionsMap
  })
  const result = await api.db.users.create(user)
  user._id = result
  const token = jwt.sign(user, api.settings.jwt_secret, {})
  return token
}

const severities = ['critical', 'error', 'warning', 'notice', 'info', 'debug']
exports.getLogSeverity = function (status) {
  const severity = status >= 500 ? 'error'
    : status >= 400 ? 'warning'
      : status >= 300 ? 'notice'
        : status >= 200 ? 'info'
          : 'debug'
  return severity
}

exports.shouldLogRequest = function (req, res) {
  const severity = exports.getLogSeverity(res.statusCode)
  const severityLoggingIndex = severities.indexOf(req.getSetting('logging_level') || 'warning')
  const severityIndex = severities.indexOf(severity)
  return severityIndex <= severityLoggingIndex
}

function filterHeaders(req) {
  const headers = req.headers || {}
  return {
    'user-agent': headers['user-agent'],
    origin: headers['origin'],
    referer: headers['referer'],
    'x-access-token': req.headers['x-access-token'] ?
      req.headers['x-access-token'].substring(0, 8) + '...' : ''
  }
}

exports.createLogEntry = function (req, res) {
  const severity = exports.getLogSeverity(res.statusCode)
  return {
    severity: severity,
    user: req.user ? req.user._id : undefined,
    url: decodeURI(req.originalUrl || req.url),
    method: req.method,
    referer: req.headers['referer'],
    req: {
      ip: req.ip,
      headers: filterHeaders(req),
    },
    res: {
      statusCode: res.statusCode,
      requestId: res._headers['x-request-id'],
      headers: res._headers
    },
    meta: {
      created: new Date().toISOString(),
      updated: new Date().toISOString()
    }
  }
}

exports.notify = async function (event, req, collection, data) {
  const listeners = req.eventListeners[event] || []
  debug('notifying ' + listeners.length + ' of ' + event + ' for ' + collection)
  let result
  for (const listener of listeners) {
    if (listener.collections && !listener.collections.includes(collection)) {
      continue // skip since it's not relevant
    }
    debug('calling ' + listener.name + ' ' + (result ? '(skipped)' : ''))
    try {
      result = result || await listener(req, collection, data, { event })
    } catch (e) {
      // If a listener has already allowed the request, do not error
      if (!result) {
        throw e
      }
    }
  }
  return result || result === undefined
}

class ApiError extends Error {
  constructor (status, message) {
    super(message)
    this.name = this.constructor.name
    Error.captureStackTrace(this, this.constructor)
    this.status = status || this.constructor.status || 500
  }
}
exports.ApiError = ApiError

exports.asyncMiddleware = fn =>
  (req, res, next) => {
    Promise.resolve(fn(req, res, next))
      .catch(next)
  }

exports.resolve = async function resolve (handler, app) {
  if (typeof handler === 'function') {
    return handler(app)
  }
  return handler
}

const STRIP_COMMENTS = /((\/\/.*$)|(\/\*[\s\S]*?\*\/))/mg
const ARGUMENT_NAMES = /([^\s,]+)/g
exports.getFunctionParamNames = function getFunctionParamNames (func) {
  const fnStr = func.toString().replace(STRIP_COMMENTS, '')
  let result = fnStr.slice(fnStr.indexOf('(')+1, fnStr.indexOf(')')).match(ARGUMENT_NAMES)
  if(result === null)
    result = []
  return result
}

exports.friendlyDuration = function friendlyDuration (seconds) {
  if (seconds > 86400) {
    return Math.round(seconds / 86400) + ' hours'
  }
  if (seconds > 3600) {
    return Math.round(seconds / 3600) + ' hours'
  }
  if (seconds > 60) {
    return Math.round(seconds / 60) + ' minutes'
  }
  return Math.round(seconds) + ' seconds'
}

exports.getPgPool = function getPgPool(connectionString) {
  if (!pgPools[connectionString]) {
    pgPools[connectionString] = new pg.Pool({ connectionString: connectionString })
  }
  return pgPools[connectionString]
}

exports.generateDocumentId = function generateDocumentId() {
  return v4()
}

exports.addIdIfMissing = function addIdIfMissing (document) {
  if (!document._id) {
    document._id = exports.generateDocumentId()
  }
}