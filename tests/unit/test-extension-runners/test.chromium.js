import path from 'path';

import { assert } from 'chai';
import { describe, it, beforeEach, afterEach } from 'mocha';
import deepcopy from 'deepcopy';
import fs from 'fs-extra';
import * as sinon from 'sinon';
import WebSocket from 'ws';

import { basicManifest, StubChildProcess } from '../helpers.js';
import {
  ChromiumExtensionRunner,
  DEFAULT_CHROME_FLAGS,
} from '../../../src/extension-runners/chromium.js';
import {
  consoleStream, // instance is imported to inspect logged messages
} from '../../../src/util/logger.js';
import { TempDir, withTempDir } from '../../../src/util/temp-dir.js';
import fileExists from '../../../src/util/file-exists.js';
import isDirectory from '../../../src/util/is-directory.js';

function prepareExtensionRunnerParams({ params } = {}) {
  const fakeChromeInstance = {
    process: new StubChildProcess(),
    kill: sinon.spy(async () => {}),
  };
  const runnerParams = {
    extensions: [
      {
        sourceDir: '/fake/sourceDir',
        manifestData: deepcopy(basicManifest),
      },
    ],
    keepProfileChanges: false,
    startUrl: undefined,
    chromiumLaunch: sinon.spy(async () => {
      return fakeChromeInstance;
    }),
    desktopNotifications: sinon.spy(() => {}),
    ...(params || {}),
  };

  return { params: runnerParams, fakeChromeInstance };
}

describe('util/extension-runners/chromium', async () => {
  it('uses the expected chrome flags', () => {
    // Flags from chrome-launcher v1.1.0
    const expectedFlags = [
      '--disable-features=Translate,OptimizationHints,MediaRouter,DialMediaRouteProvider,CalculateNativeWinOcclusion,InterestFeedContentSuggestions,CertificateTransparencyComponentUpdater,AutofillServerCommunication',
      '--disable-component-extensions-with-background-pages',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-client-side-phishing-detection',
      '--disable-sync',
      '--metrics-recording-only',
      '--disable-default-apps',
      '--no-default-browser-check',
      '--no-first-run',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      '--disable-ipc-flooding-protection',
      '--password-store=basic',
      '--use-mock-keychain',
      '--force-fieldtrials=*BackgroundTracing/default/',
      '--disable-hang-monitor',
      '--disable-prompt-on-repost',
      '--disable-domain-reliability',
    ];

    assert.deepEqual(DEFAULT_CHROME_FLAGS, expectedFlags);
  });

  it('installs and runs the extension', async () => {
    const { params, fakeChromeInstance } = prepareExtensionRunnerParams();
    const runnerInstance = new ChromiumExtensionRunner(params);
    assert.equal(runnerInstance.getName(), 'Chromium');

    await runnerInstance.run();

    sinon.assert.calledOnce(params.chromiumLaunch);
    sinon.assert.calledWithMatch(params.chromiumLaunch, {
      ignoreDefaultFlags: true,
      enableExtensions: true,
      chromePath: undefined,
      chromeFlags: [
        ...DEFAULT_CHROME_FLAGS,
        '--load-extension=/fake/sourceDir',
      ],
      startingUrl: undefined,
    });

    await runnerInstance.exit();
    sinon.assert.calledOnce(fakeChromeInstance.kill);
  });

  it('exits if the chrome instance is shutting down', async () => {
    const { params, fakeChromeInstance } = prepareExtensionRunnerParams();
    const runnerInstance = new ChromiumExtensionRunner(params);
    await runnerInstance.run();

    const onceExiting = new Promise((resolve) =>
      runnerInstance.registerCleanup(resolve),
    );

    fakeChromeInstance.process.emit('close');

    await onceExiting;
  });

  it('calls all cleanup callbacks on exit', async () => {
    const { params } = prepareExtensionRunnerParams();
    const runnerInstance = new ChromiumExtensionRunner(params);
    await runnerInstance.run();

    runnerInstance.registerCleanup(function fnThrowsError() {
      throw new Error('fake cleanup exception');
    });

    const onceExiting = new Promise((resolve) =>
      runnerInstance.registerCleanup(resolve),
    );

    await runnerInstance.exit();
    await onceExiting;
  });

  it('does not call exit if chrome instance exits while shutting down', async () => {
    const { params, fakeChromeInstance } = prepareExtensionRunnerParams();
    const runnerInstance = new ChromiumExtensionRunner(params);
    await runnerInstance.run();

    sinon.spy(runnerInstance, 'exit');

    const exitDone = runnerInstance.exit();
    fakeChromeInstance.process.emit('close');

    await exitDone;

    sinon.assert.calledOnce(runnerInstance.exit);
  });

  it('awaits for the async setup to complete before exiting', async () => {
    const { params } = prepareExtensionRunnerParams({
      params: {
        chromiumLaunch: sinon.spy(async () => {
          throw new Error('Fake chromiumLaunch ERROR');
        }),
      },
    });
    const runnerInstance = new ChromiumExtensionRunner(params);
    assert.equal(runnerInstance.getName(), 'Chromium');

    await assert.isRejected(runnerInstance.run(), /Fake chromiumLaunch ERROR/);

    // Clear console stream from previous messages and start recording
    consoleStream.stopCapturing();
    consoleStream.flushCapturedLogs();
    consoleStream.startCapturing();
    // Make verbose to capture debug logs.
    consoleStream.makeVerbose();

    // Call exit and then verify that it caught the chromiumLaunch rejection
    // and logged it as a debug log.
    await runnerInstance.exit();

    // Retrieve captures logs and stop capturing.
    const { capturedMessages } = consoleStream;
    consoleStream.stopCapturing();

    assert.ok(
      capturedMessages.some(
        (message) =>
          message.match('[debug]') &&
          message.match('ignored setup error on chromium runner shutdown') &&
          message.match('Fake chromiumLaunch ERROR'),
      ),
    );
  });

  it('does use a custom chromium binary when passed', async () => {
    const { params } = prepareExtensionRunnerParams({
      params: { chromiumBinary: '/my/custom/chrome-bin' },
    });

    const runnerInstance = new ChromiumExtensionRunner(params);
    await runnerInstance.run();

    sinon.assert.calledOnce(params.chromiumLaunch);
    sinon.assert.calledWithMatch(params.chromiumLaunch, {
      ignoreDefaultFlags: true,
      enableExtensions: true,
      chromePath: '/my/custom/chrome-bin',
      chromeFlags: [
        ...DEFAULT_CHROME_FLAGS,
        '--load-extension=/fake/sourceDir',
      ],
      startingUrl: undefined,
    });

    await runnerInstance.exit();
  });

  it('does pass multiple starting urls to chrome', async () => {
    const { params } = prepareExtensionRunnerParams({
      params: { startUrl: ['url1', 'url2', 'url3'] },
    });

    const runnerInstance = new ChromiumExtensionRunner(params);
    await runnerInstance.run();

    sinon.assert.calledOnce(params.chromiumLaunch);
    sinon.assert.calledWithMatch(params.chromiumLaunch, {
      ignoreDefaultFlags: true,
      enableExtensions: true,
      chromePath: undefined,
      chromeFlags: [
        ...DEFAULT_CHROME_FLAGS,
        '--load-extension=/fake/sourceDir',
        'url2',
        'url3',
      ],
      startingUrl: 'url1',
    });

    await runnerInstance.exit();
  });

  it('does pass additional args to chrome', async () => {
    const { params } = prepareExtensionRunnerParams({
      params: {
        args: ['--arg1', 'arg2', '--arg3'],
        startUrl: ['url1', 'url2', 'url3'],
      },
    });

    const runnerInstance = new ChromiumExtensionRunner(params);
    await runnerInstance.run();

    sinon.assert.calledOnce(params.chromiumLaunch);
    sinon.assert.calledWithMatch(params.chromiumLaunch, {
      ignoreDefaultFlags: true,
      enableExtensions: true,
      chromePath: undefined,
      chromeFlags: [
        ...DEFAULT_CHROME_FLAGS,
        '--load-extension=/fake/sourceDir',
        '--arg1',
        'arg2',
        '--arg3',
        'url2',
        'url3',
      ],
      startingUrl: 'url1',
    });

    await runnerInstance.exit();
  });

  it('does use a random user-data-dir', async () => {
    const { params } = prepareExtensionRunnerParams({
      params: {},
    });

    const spy = sinon.spy(TempDir.prototype, 'path');

    const runnerInstance = new ChromiumExtensionRunner(params);
    await runnerInstance.run();

    const usedTempPath = spy.returnValues[2];

    sinon.assert.calledWithMatch(params.chromiumLaunch, {
      userDataDir: usedTempPath,
    });

    await runnerInstance.exit();
    spy.restore();
  });

  it('does pass a user-data-dir flag to chrome', async () =>
    withTempDir(async (tmpDir) => {
      const { params } = prepareExtensionRunnerParams({
        params: {
          chromiumProfile: tmpDir.path(),
        },
      });

      const spy = sinon.spy(TempDir.prototype, 'path');

      const runnerInstance = new ChromiumExtensionRunner(params);
      await runnerInstance.run();

      const usedTempPath = spy.returnValues[2];

      sinon.assert.calledOnce(params.chromiumLaunch);
      sinon.assert.calledWithMatch(params.chromiumLaunch, {
        ignoreDefaultFlags: true,
        enableExtensions: true,
        chromePath: undefined,
        userDataDir: usedTempPath,
        chromeFlags: [
          ...DEFAULT_CHROME_FLAGS,
          '--load-extension=/fake/sourceDir',
        ],
        startingUrl: undefined,
      });

      await runnerInstance.exit();
      spy.restore();
    }));

  it(
    'does pass existing user-data-dir and profile-directory flag' +
      ' to chrome',
    async () =>
      withTempDir(async (tmpDir) => {
        const tmpPath = tmpDir.path();
        await fs.mkdirs(path.join(tmpPath, 'userDataDir/Default'));
        await fs.outputFile(path.join(tmpPath, 'userDataDir/Local State'), '');
        await fs.mkdirs(path.join(tmpPath, 'userDataDir/profile'));
        await fs.outputFile(
          path.join(tmpPath, 'userDataDir/profile/Secure Preferences'),
          '',
        );

        const { params } = prepareExtensionRunnerParams({
          params: {
            chromiumProfile: path.join(tmpPath, 'userDataDir/profile'),
            keepProfileChanges: true,
          },
        });

        const runnerInstance = new ChromiumExtensionRunner(params);
        await runnerInstance.run();

        sinon.assert.calledOnce(params.chromiumLaunch);
        sinon.assert.calledWithMatch(params.chromiumLaunch, {
          ignoreDefaultFlags: true,
          enableExtensions: true,
          chromePath: undefined,
          userDataDir: path.join(tmpPath, 'userDataDir'),
          chromeFlags: [
            ...DEFAULT_CHROME_FLAGS,
            '--load-extension=/fake/sourceDir',
            '--profile-directory=profile',
          ],
          startingUrl: undefined,
        });

        await runnerInstance.exit();
      }),
  );

  it('does support some special chars in profile-directory flag', async () =>
    withTempDir(async (tmpDir) => {
      const tmpPath = tmpDir.path();
      // supported to test: [ _-]
      // not supported by Chromium: [ßäé]
      const profileDirName = " profile _-' ";
      await fs.mkdirs(path.join(tmpPath, 'userDataDir/Default'));
      await fs.outputFile(path.join(tmpPath, 'userDataDir/Local State'), '');
      await fs.mkdirs(path.join(tmpPath, 'userDataDir', profileDirName));
      await fs.outputFile(
        path.join(tmpPath, 'userDataDir', profileDirName, 'Secure Preferences'),
        '',
      );

      const { params } = prepareExtensionRunnerParams({
        params: {
          chromiumProfile: path.join(tmpPath, 'userDataDir', profileDirName),
          keepProfileChanges: true,
        },
      });

      const runnerInstance = new ChromiumExtensionRunner(params);
      await runnerInstance.run();

      sinon.assert.calledOnce(params.chromiumLaunch);
      sinon.assert.calledWithMatch(params.chromiumLaunch, {
        ignoreDefaultFlags: true,
        enableExtensions: true,
        chromePath: undefined,
        userDataDir: path.join(tmpPath, 'userDataDir'),
        chromeFlags: [
          ...DEFAULT_CHROME_FLAGS,
          '--load-extension=/fake/sourceDir',
          `--profile-directory=${profileDirName}`,
        ],
        startingUrl: undefined,
      });

      await runnerInstance.exit();
    }));

  it('does recognize a UserData dir', async () =>
    withTempDir(async (tmpDir) => {
      const tmpPath = tmpDir.path();
      await fs.mkdirs(path.join(tmpPath, 'Default'));
      await fs.outputFile(path.join(tmpPath, 'Local State'), '');

      assert.isTrue(await ChromiumExtensionRunner.isUserDataDir(tmpPath));
    }));

  it('does reject a UserData dir with Local State dir', async () =>
    withTempDir(async (tmpDir) => {
      const tmpPath = tmpDir.path();
      await fs.mkdirs(path.join(tmpPath, 'Default'));
      // Local State should be a file
      await fs.mkdirs(path.join(tmpPath, 'Local State'));

      assert.isFalse(await ChromiumExtensionRunner.isUserDataDir(tmpPath));
    }));

  it('does reject a UserData dir with Default file', async () =>
    withTempDir(async (tmpDir) => {
      const tmpPath = tmpDir.path();
      await fs.mkdirs(path.join(tmpPath, 'Local State'));
      // Default should be a directory
      await fs.outputFile(path.join(tmpPath, 'Default'), '');

      assert.isFalse(await ChromiumExtensionRunner.isUserDataDir(tmpPath));
    }));

  it('throws an error on profile in invalid user-data-dir', async () =>
    withTempDir(async (tmpDir) => {
      const tmpPath = tmpDir.path();
      await fs.mkdirs(path.join(tmpPath, 'userDataDir/profile'));
      // the userDataDir is missing a file Local State to be validated as such
      await fs.outputFile(
        path.join(tmpPath, 'userDataDir/profile/Secure Preferences'),
        '',
      );

      const { params } = prepareExtensionRunnerParams({
        params: {
          chromiumProfile: path.join(tmpPath, 'userDataDir/profile'),
          keepProfileChanges: true,
        },
      });

      const runnerInstance = new ChromiumExtensionRunner(params);

      await assert.isRejected(runnerInstance.run(), /not in a user-data-dir/);

      await runnerInstance.exit();
    }));

  it(
    'does copy the profile and pass user-data-dir and profile-directory' +
      ' flags',
    async () =>
      withTempDir(async (tmpDir) => {
        const tmpPath = tmpDir.path();
        await fs.mkdirs(path.join(tmpPath, 'userDataDir/profile'));
        await fs.outputFile(
          path.join(tmpPath, 'userDataDir/profile/Secure Preferences'),
          '',
        );

        const { params } = prepareExtensionRunnerParams({
          params: {
            chromiumProfile: path.join(tmpPath, 'userDataDir/profile'),
          },
        });

        const spy = sinon.spy(TempDir.prototype, 'path');

        const runnerInstance = new ChromiumExtensionRunner(params);
        await runnerInstance.run();

        const usedTempPath = spy.returnValues[2];

        sinon.assert.calledOnce(params.chromiumLaunch);
        sinon.assert.calledWithMatch(params.chromiumLaunch, {
          ignoreDefaultFlags: true,
          enableExtensions: true,
          chromePath: undefined,
          userDataDir: usedTempPath,
          chromeFlags: [
            ...DEFAULT_CHROME_FLAGS,
            '--load-extension=/fake/sourceDir',
            '--profile-directory=profile',
          ],
          startingUrl: undefined,
        });

        assert.isTrue(await isDirectory(path.join(usedTempPath, 'profile')));
        assert.isTrue(
          await fileExists(
            path.join(usedTempPath, 'profile/Secure Preferences'),
          ),
        );

        await runnerInstance.exit();
        spy.restore();
      }),
  );

  it('does pass default prefs to chrome', async () => {
    const { params } = prepareExtensionRunnerParams();

    const runnerInstance = new ChromiumExtensionRunner(params);
    await runnerInstance.run();

    sinon.assert.calledOnce(params.chromiumLaunch);
    sinon.assert.calledWithMatch(params.chromiumLaunch, {
      prefs: {
        extensions: {
          ui: {
            developer_mode: true,
          },
        },
      },
    });

    await runnerInstance.exit();
  });

  it('does pass custom prefs to chrome', async () => {
    const { params } = prepareExtensionRunnerParams({
      params: {
        customChromiumPrefs: {
          'download.default_directory': '/some/directory',
          'extensions.ui.developer_mode': false,
        },
      },
    });

    const runnerInstance = new ChromiumExtensionRunner(params);
    await runnerInstance.run();

    sinon.assert.calledOnce(params.chromiumLaunch);
    sinon.assert.calledWithMatch(params.chromiumLaunch, {
      prefs: {
        download: {
          default_directory: '/some/directory',
        },
        extensions: {
          ui: {
            developer_mode: false,
          },
        },
      },
    });

    await runnerInstance.exit();
  });

  describe('reloadAllExtensions', () => {
    let runnerInstance;
    let wsClient;

    beforeEach(async () => {
      const { params } = prepareExtensionRunnerParams();
      runnerInstance = new ChromiumExtensionRunner(params);
      await runnerInstance.run();
    });

    const connectClient = async () => {
      if (!runnerInstance.wss) {
        throw new Error('WebSocker server is not running');
      }
      const wssInfo = runnerInstance.wss.address();
      const wsURL = `ws://${wssInfo.address}:${wssInfo.port}`;
      wsClient = new WebSocket(wsURL);
      await new Promise((resolve) => wsClient.on('open', resolve));
    };

    afterEach(async () => {
      if (wsClient && wsClient.readyState === WebSocket.OPEN) {
        wsClient.close();
        wsClient = null;
      }
      await runnerInstance.exit();
    });

    it('does not resolve before complete message from client', async () => {
      let reloadMessage = false;
      await connectClient();

      wsClient.on('message', (message) => {
        const msg = JSON.parse(message);

        if (msg.type === 'webExtReloadAllExtensions') {
          assert.equal(reloadMessage, false);

          setTimeout(() => {
            const respondMsg = JSON.stringify({
              type: 'webExtReloadExtensionComplete',
            });
            wsClient.send(respondMsg);
            reloadMessage = true;
          }, 333);
        }
      });

      await runnerInstance.reloadAllExtensions();
      assert.equal(reloadMessage, true);
    });

    it('resolve when any client send complete message', async () => {
      await connectClient();
      wsClient.on('message', () => {
        const msg = JSON.stringify({ type: 'webExtReloadExtensionComplete' });
        wsClient.send(msg);
      });
      await runnerInstance.reloadAllExtensions();
    });

    it('resolve when all client disconnect', async () => {
      await connectClient();
      await new Promise((resolve) => {
        wsClient.on('close', () => {
          resolve(runnerInstance.reloadAllExtensions());
        });
        wsClient.close();
      });
      wsClient = null;
    });

    it('resolve when not client connected', async () => {
      await runnerInstance.reloadAllExtensions();
    });
  });
});
