import { logger, instance as npmLog } from '@storybook/node-logger';
import prompts from 'prompts';
import {
  CLIOptions,
  LoadOptions,
  BuilderOptions,
  Options,
  StorybookConfig,
  CoreConfig,
  resolvePathInStorybookCache,
  loadAllPresets,
  cache,
} from '@storybook/core-common';
import { telemetry } from '@storybook/telemetry';
import dedent from 'ts-dedent';
import global from 'global';

import path from 'path';
import { storybookDevServer } from './dev-server';
import { getDevCli } from './cli';
import { getReleaseNotesData, getReleaseNotesFailedState } from './utils/release-notes';
import { outputStats } from './utils/output-stats';
import { outputStartupInformation } from './utils/output-startup-information';
import { updateCheck } from './utils/update-check';
import { getServerPort, getServerChannelUrl } from './utils/server-address';
import { getPreviewBuilder } from './utils/get-preview-builder';
import { getManagerBuilder } from './utils/get-manager-builder';

export async function buildDevStandalone(options: CLIOptions & LoadOptions & BuilderOptions) {
  const { packageJson, versionUpdates, releaseNotes } = options;
  const { version, name = '' } = packageJson;

  // updateInfo and releaseNotesData are cached, so this is typically pretty fast
  const [port, versionCheck, releaseNotesData] = await Promise.all([
    getServerPort(options.port),
    versionUpdates
      ? updateCheck(version)
      : Promise.resolve({ success: false, data: {}, time: Date.now() }),
    releaseNotes
      ? getReleaseNotesData(version, cache)
      : Promise.resolve(getReleaseNotesFailedState(version)),
  ]);

  if (!options.ci && !options.smokeTest && options.port != null && port !== options.port) {
    const { shouldChangePort } = await prompts({
      type: 'confirm',
      initial: true,
      name: 'shouldChangePort',
      message: `Port ${options.port} is not available. Would you like to run Storybook on port ${port} instead?`,
    });
    if (!shouldChangePort) process.exit(1);
  }

  /* eslint-disable no-param-reassign */
  options.port = port;
  options.versionCheck = versionCheck;
  options.releaseNotesData = releaseNotesData;
  options.configType = 'DEVELOPMENT';
  options.configDir = path.resolve(options.configDir);
  options.outputDir = options.smokeTest
    ? resolvePathInStorybookCache('public')
    : path.resolve(options.outputDir || resolvePathInStorybookCache('public'));
  options.serverChannelUrl = getServerChannelUrl(port, options);
  /* eslint-enable no-param-reassign */

  const previewBuilder = await getPreviewBuilder(options.configDir);
  const managerBuilder = await getManagerBuilder(options.configDir);

  const presets = loadAllPresets({
    corePresets: [
      require.resolve('./presets/common-preset'),
      ...managerBuilder.corePresets,
      ...previewBuilder.corePresets,
      require.resolve('./presets/babel-cache-preset'),
    ],
    overridePresets: previewBuilder.overridePresets,
    ...options,
  });

  const features = await presets.apply<StorybookConfig['features']>('features');
  global.FEATURES = features;

  const fullOptions: Options = {
    ...options,
    presets,
    features,
  };

  const { address, networkAddress, managerResult, previewResult } = await storybookDevServer(
    fullOptions
  );

  const previewTotalTime = previewResult && previewResult.totalTime;
  const managerTotalTime = managerResult && managerResult.totalTime;

  const previewStats = previewResult && previewResult.stats;
  const managerStats = managerResult && managerResult.stats;

  if (options.webpackStatsJson) {
    const target = options.webpackStatsJson === true ? options.outputDir : options.webpackStatsJson;
    await outputStats(target, previewStats, managerStats);
  }

  if (options.smokeTest) {
    // @ts-ignore
    const managerWarnings = (managerStats && managerStats.toJson().warnings) || [];
    if (managerWarnings.length > 0)
      logger.warn(`manager: ${JSON.stringify(managerWarnings, null, 2)}`);
    // I'm a little reticent to import webpack types in this file :shrug:
    // @ts-ignore
    const previewWarnings = (previewStats && previewStats.toJson().warnings) || [];
    if (previewWarnings.length > 0)
      logger.warn(`preview: ${JSON.stringify(previewWarnings, null, 2)}`);
    process.exit(
      managerWarnings.length > 0 || (previewWarnings.length > 0 && !options.ignorePreview) ? 1 : 0
    );
    return;
  }

  // Get package name and capitalize it e.g. @storybook/react -> React
  const packageName = name.split('@storybook/').length > 1 ? name.split('@storybook/')[1] : name;
  const frameworkName = packageName.charAt(0).toUpperCase() + packageName.slice(1);

  outputStartupInformation({
    updateInfo: versionCheck,
    version,
    name: frameworkName,
    address,
    networkAddress,
    managerTotalTime,
    previewTotalTime,
  });
}

export async function buildDev(loadOptions: LoadOptions) {
  const cliOptions = await getDevCli(loadOptions.packageJson);
  const options: CLIOptions & LoadOptions & BuilderOptions = {
    ...cliOptions,
    ...loadOptions,
    configDir: loadOptions.configDir || cliOptions.configDir || './.storybook',
    configType: 'DEVELOPMENT',
    ignorePreview: !!cliOptions.previewUrl && !cliOptions.forceBuildPreview,
    docsMode: !!cliOptions.docs,
    cache,
  };

  try {
    await buildDevStandalone(options);
  } catch (error) {
    // this is a weird bugfix, somehow 'node-pre-gyp' is polluting the npmLog header
    npmLog.heading = '';

    if (error instanceof Error) {
      if ((error as any).error) {
        logger.error((error as any).error);
      } else if ((error as any).stats && (error as any).stats.compilation.errors) {
        (error as any).stats.compilation.errors.forEach((e: any) => logger.plain(e));
      } else {
        logger.error(error as any);
      }
    } else if (error.compilation?.errors) {
      error.compilation.errors.forEach((e: any) => logger.plain(e));
    }

    logger.line();
    logger.warn(
      error.close
        ? dedent`
          FATAL broken build!, will close the process,
          Fix the error below and restart storybook.
        `
        : dedent`
          Broken build, fix the error above.
          You may need to refresh the browser.
        `
    );
    logger.line();

    const presets = loadAllPresets({
      corePresets: [require.resolve('./presets/common-preset')],
      overridePresets: [],
      ...options,
    });

    const core = await presets.apply<CoreConfig>('core');
    if (!core?.disableTelemetry) {
      let enableCrashReports;
      if (core.enableCrashReports !== undefined) {
        enableCrashReports = core.enableCrashReports;
      } else {
        const valueFromCache = await cache.get('enableCrashreports');
        if (valueFromCache !== undefined) {
          enableCrashReports = valueFromCache;
        } else {
          const valueFromPrompt = await promptCrashReports(options);
          if (valueFromPrompt !== undefined) {
            enableCrashReports = valueFromPrompt;
          }
        }
      }

      await telemetry(
        'error-dev',
        { error },
        {
          immediate: true,
          configDir: options.configDir,
          enableCrashReports,
        }
      );
    }
    process.exit(1);
  }
}

const promptCrashReports = async ({ packageJson }: CLIOptions & LoadOptions & BuilderOptions) => {
  if (process.env.CI) {
    return undefined;
  }

  const { enableCrashReports } = await prompts({
    type: 'confirm',
    name: 'enableCrashReports',
    message: `Would you like to send crash reports to Storybook?`,
    initial: true,
  });

  await cache.set('enableCrashreports', enableCrashReports);

  return enableCrashReports;
};
