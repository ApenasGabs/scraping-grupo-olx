const puppeteer = require("puppeteer");
const fs = require("fs").promises;
const path = require("path");
const { saveJSON, loadJSON } = require("../utils/fileHelper");
const { createTargetURL } = require("../config/zapConfig");
const { simulateInteractions } = require("../utils/interactionsHelper");

const logError = async (message, details = {}) => {
  const logPath = path.join(__dirname, "../data/results/zapErrors.json");
  let logs = [];

  try {
    const existingContent = await fs
      .readFile(logPath, "utf8")
      .catch(() => "[]");
    logs = JSON.parse(existingContent);
  } catch (e) {
    logs = [];
  }

  logs.push({
    timestamp: new Date().toISOString(),
    message,
    details,
  });

  await fs.writeFile(logPath, JSON.stringify(logs, null, 2));
  console.error(`[ERROR LOG] ${message}`);
};

const getHouseList = async (page) => {
  const basicData = await page.evaluate(() => {
    const filteredItems = Array.from(
      document.querySelectorAll(
        'div.listings-wrapper li[data-cy="rp-property-cd"]'
      )
    );
    const generatePropertyId = () => {
      const now = new Date();
      const timestamp = now.getTime();
      const randomSuffix = Math.floor(Math.random() * 1000);

      return `prop_${timestamp}_${randomSuffix}`;
    };

    return filteredItems.map((li, idx) => {
      const card = li.querySelector('div[data-testid="card"]');
      const description = Array.from(
        card.querySelectorAll('p[data-testid="card-amenity"]')
      ).reduce((acc, el) => {
        const key = el.getAttribute("itemprop");
        const value = el.innerText.split(" ").shift();
        acc.push({ [key]: value });
        return acc;
      }, []);

      const images = Array.from(
        li.querySelectorAll(
          'div[data-cy="rp-cardProperty-image-img"] ul li img'
        )
      ).map((img) => img.src);

      const price = card
        .querySelector('div[data-cy="rp-cardProperty-price-txt"] p')
        ?.innerText?.replace(/[R$\s.]/g, "");

      const address = card.querySelector(
        '[data-cy="rp-cardProperty-location-txt"]'
      )?.innerText;

      const hasDuplicates =
        card.querySelector(
          'button[data-cy="listing-card-deduplicated-button"]'
        ) !== null;

      const liId = `house-item-${idx}`;
      li.id = liId;

      const simpleLink = li.querySelector("a")?.href;

      return {
        id: generatePropertyId(),
        address,
        description,
        images,
        link: simpleLink,
        price,
        hasDuplicates,
        scrapedAt: new Date().toISOString(),
        elementId: liId,
      };
    });
  });

  const results = [];
  for (const house of basicData) {
    if (house.hasDuplicates) {
      try {
        await page.click(
          `#${house.elementId} button[data-cy="listing-card-deduplicated-button"]`
        );

        // Espere pelo modal
        await page.waitForSelector(
          'section[data-cy="deduplication-modal-list-step"]',
          {
            timeout: 5000,
          }
        );

        // Obtenha os links alternativos
        const links = await page.evaluate(() => {
          const linksSection = document.querySelector(
            'section[data-cy="deduplication-modal-list-step"]'
          );
          if (!linksSection) return [];
          return Array.from(linksSection.querySelectorAll("a")).map(
            (a) => a.href
          );
        });

        // Atualize o link se houver alternativas
        if (links && links.length > 0) {
          house.link = links[0];
        }

        // Feche o modal
        await page.keyboard.press("Escape");
        await page.waitForTimeout(500);
      } catch (error) {
        console.error(
          `Erro ao processar duplicados para ${house.elementId}:`,
          error
        );
      }
    }
    results.push(house);
  }

  return results;
};

module.exports = async (maxPrice) => {
  console.log("maxPrice: ", maxPrice);
  const houseList = [];
  let browser;
  let page;
  try {
    let pageNumber = 1;
    let hasNextPage = true;
    const browserProps = {
      headless: false,
      defaultViewport: { width: 1980, height: 1280 },
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--window-size=1980,1280",
      ],
    };
    while (hasNextPage) {
      browser = await puppeteer.launch(browserProps);
      page = await browser.newPage();
      console.log(`Acessando página ${pageNumber}`);
      const url = createTargetURL({ pagina: pageNumber });

      try {
        await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: 0,
        });

        try {
          await page.waitForSelector("div.listings-wrapper", {
            timeout: 10000,
          });
        } catch (selectorError) {
          await logError(
            `Falha ao encontrar div.listings-wrapper ${selectorError}`,
            {
              page: pageNumber,
              url,
              errorMessage: selectorError.message,
            }
          );

          const hasContent = await page.evaluate(() => {
            return document.body.innerText.length > 100;
          });

          if (!hasContent) {
            throw new Error("Página sem conteúdo suficiente");
          }

          await page.waitForTimeout(5000);
        }

        await simulateInteractions(page, "zapInteractionData");

        let newHouses = await getHouseList(page);

        console.log("newHouses: ", newHouses);

        if (newHouses.length === 0) {
          console.log("Nenhuma casa encontrada nesta página.");
          throw new Error("A lista de casas está vazia.");
        }

        houseList.push(...newHouses);

        const lastHighPrice = newHouses[newHouses.length - 1]?.price || 0;

        if (parseInt(lastHighPrice) >= maxPrice) {
          console.log("preço final chegou: ", lastHighPrice);
          hasNextPage = false;
        }
        pageNumber++;
        await browser.close();
      } catch (pageError) {
        await logError(`Erro ao processar página ${pageNumber}, ${pageError}`, {
          url,
          errorMessage: pageError.message,
        });

        if (page) {
          const screenshotPath = `data/results/erro_zap_pagina_${pageNumber}_${new Date()
            .toLocaleString("pt-BR", {
              timeZone: "America/Sao_Paulo",
              dateStyle: "short",
              timeStyle: "short",
            })
            .replace(/[/:,]/g, "-")
            .replace(/ /g, "_")}.png`;

          await page.screenshot({
            path: screenshotPath,
            fullPage: true,
          });

          await logError("Screenshot salvo", { path: screenshotPath });
        }

        pageNumber++;
        if (browser) await browser.close();
        continue;
      }
    }

    console.log("Total de casas encontradas:", houseList.length);

    if (houseList.length > 0) {
      const filePath = path.join(__dirname, "../data/results/zapResults.json");
      await saveJSON(filePath, houseList);
      console.log("Dados atualizados salvos em zapResults.json");
    } else {
      console.log("Nenhuma casa encontrada. JSON não salvo.");
    }
  } catch (error) {
    console.error("Erro durante o scraping:", error);
    await logError("Erro geral durante o scraping", {
      errorMessage: error.message,
      stack: error.stack,
    });

    if (page) {
      const screenshotPath = `data/results/erro_zap_${new Date()
        .toLocaleString("pt-BR", {
          timeZone: "America/Sao_Paulo",
          dateStyle: "long",
          timeStyle: "medium",
        })
        .replace(/[/:,]/g, "-")
        .replace(/ /g, "_")}.png`;

      await page.screenshot({
        path: screenshotPath,
        fullPage: true,
      });

      await logError("Screenshot salvo", { path: screenshotPath });
    }
  } finally {
    if (browser) {
      await browser.close();
    }
  }
};
