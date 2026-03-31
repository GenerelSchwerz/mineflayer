const fs = require('fs')
const path = require('path')
const compatibilityTracker = require('./compatibility')
const { normalizeDescriptor } = require('./descriptor')

function loadExternalTests ({ externalTestsFolder, supportedVersion, excludedTests = [] }) {
  return fs.readdirSync(externalTestsFolder)
    .filter(file => fs.statSync(path.join(externalTestsFolder, file)).isFile())
    .map(file => path.basename(file, '.js'))
    .filter(testName => !excludedTests.includes(testName))
    .flatMap((testName) => {
      const factory = require(path.join(externalTestsFolder, testName))
      const compatibility = compatibilityTracker[testName] ?? {}
      return normalizeDescriptor(testName, factory(supportedVersion)).map(test => ({
        ...test,
        isolation: compatibility.isolation ?? test.isolation,
        compatibility: compatibility.compatibility ?? test.compatibility,
        workspaceRadius: compatibility.workspaceRadius ?? test.workspaceRadius,
        workspaceSize: compatibility.workspaceSize ?? test.workspaceSize,
        exampleBot: compatibility.exampleBot ?? test.exampleBot
      }))
    })
}

module.exports = { loadExternalTests }
