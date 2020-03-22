/*
 * This file is part of Adblock Plus <https://adblockplus.org/>,
 * Copyright (C) 2006-present eyeo GmbH
 *
 * Adblock Plus is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3 as
 * published by the Free Software Foundation.
 *
 * Adblock Plus is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with Adblock Plus.  If not, see <http://www.gnu.org/licenses/>.
 */

"use strict";

const TEST_PAGES_URL = "https://testpages.adblockplus.org/en/";

const glob = require("glob");
const path = require("path");
const url = require("url");
const {exec} = require("child_process");
const {download} = require("./misc/utils");

function getBrowserBinaries(module, browser)
{
  let spec = process.env[`${browser.toUpperCase()}_BINARY`];
  if (spec)
  {
    if (spec == "installed")
      return [{getPath: () => Promise.resolve(null)}];
    if (spec.startsWith("path:"))
      return [{getPath: () => Promise.resolve(spec.substr(5))}];
    if (spec.startsWith("download:"))
      return [{getPath: () => module.ensureBrowser(spec.substr(9))}];
  }

  return [
    {
      version: "oldest",
      getPath: () => module.ensureBrowser(module.oldestCompatibleVersion)
    },
    {
      version: "latest",
      getPath: () => module.getLatestVersion().then(module.ensureBrowser)
    }
  ];
}

function createDevenv(platform)
{
  return new Promise((resolve, reject) =>
  {
    exec(
      `bash -c "python build.py devenv -t ${platform}"`,
      (error, stdout, stderr) =>
      {
        if (error)
        {
          console.error(stderr);
          reject(error);
        }
        else resolve(stdout);
      }
    );
  });
}

async function getDriver(binary, devenvCreated, module)
{
  let [browserBin] = await Promise.all([binary.getPath(), devenvCreated]);
  return module.getDriver(
    browserBin,
    path.resolve(`./devenv.${module.platform}`)
  );
}

async function getOrigin(driver)
{
  let handle = await driver.wait(
    async() => (await driver.getAllWindowHandles())[1]
  );
  await driver.switchTo().window(handle);
  return driver.wait(async() =>
  {
    let origin = await driver.executeScript("return location.origin;");
    return origin != "null" ? origin : null;
  }, 1000, "unknown extension page origin");
}

function reloadModulesForBrowser(file)
{
  let modulePath = path.resolve(file);
  delete require.cache[require.resolve(modulePath)];
  require(modulePath);
}

async function getPageTests()
{
  let html;
  try
  {
    html = await download(TEST_PAGES_URL);
  }
  catch (e)
  {
    return [];
  }

  let regexp = /<li>[\S\s]*?<a (?:class="(.*?)" )?href="(.*?)"[\S\s]*?<h3>(.*)<\/h3>/gm;
  let tests = [];
  let match;
  while (match = regexp.exec(html))
    tests.push([match[1], url.resolve(TEST_PAGES_URL, match[2]), match[3]]);

  return tests;
}

if (typeof run == "undefined")
{
  console.error("--delay option required");
  process.exit(1);
}

(async() =>
{
  let pageTests = await getPageTests();
  for (let backend of glob.sync("./test/browsers/*.js"))
  {
    let module = require(path.resolve(backend));
    let browser = path.basename(backend, ".js");
    let devenvCreated = null;
    for (let binary of getBrowserBinaries(module, browser))
    {
      let description = browser.replace(/./, c => c.toUpperCase());
      if (binary.version)
        description += ` (${binary.version})`;

      describe(description, function()
      {
        this.timeout(0);
        this.pageTests = pageTests;
        this.testPagesURL = TEST_PAGES_URL;

        before(async function()
        {
          if (!devenvCreated)
            devenvCreated = createDevenv(module.platform);

          this.driver = await getDriver(binary, devenvCreated, module);
          this.origin = await getOrigin(this.driver);
        });

        for (let file of glob.sync("./test/wrappers/*.js"))
          reloadModulesForBrowser(file, pageTests);

        after(async function()
        {
          if (this.driver)
            await this.driver.quit();
        });
      });
    }
  }
  run();
})();
