// Control script for the normal webpage by itself!

const DEBUG_VERBOSITY_NAV = 0;

//////////////////////////////////////////////
/*             ~~~ Helpers ~~~              */
//////////////////////////////////////////////

function changeSimVeilVisibility(val) {
    // arguably should go in the fluid controller script,
    // but that thing's too long anways
    let simVeil = document.getElementById('shader-canvas-veil');
    if (!simVeil) return;
    if (val)
        simVeil.classList.remove('disappeared');
    else
        simVeil.classList.add('disappeared')
}
window.changeSimVeilVisibility = changeSimVeilVisibility;
function gotoPage(id) {
    // Disable all pages except for the one with that ID
    var found = false;
    var activeIndex = -1;
    for (let i = 0; i < pageDestinations.length; ++i) {
        if (pageDestinations.item(i).getAttribute('page-id') == id) {
            pageDestinations.item(i).classList.remove('inactive');
            found = true;
            continue;
        }
        pageDestinations.item(i).classList.add('inactive');
    }
    if (!found) {
        console.error(`Cannot jump to page; page of ID \"${id}\" not found.`);
        // Revert changes if an error was made
        if (activeIndex >= 0) {
            for (let i = 0; i < pageDestinations.length; ++i) {
                if (i == activeIndex)
                    pageDestinations.item(i).classList.remove('inactive');
                else
                    pageDestinations.item(i).classList.add('inactive');
            }
        }
        return;
    }
    if (DEBUG_VERBOSITY_NAV >= 1)
        console.log(`Successfully jumped to page with ID \"${id}\".`);
}

//////////////////////////////////////////////
/*          ~~~ Initialization ~~~          */
//////////////////////////////////////////////

var pageLinks = null;
var pageDestinations = null;
window.initNavigation = function initNavigation() {
    // Find all destination pages
    pageDestinations = document.getElementsByClassName('floating-body');
    // Find all elements with links & make them redirect to their desired page
    let links = document.getElementsByClassName('page-link');
    pageLinks = Array(links.length);
    for (let i = 0; i < links.length; ++i) {
        pageLinks[i] = {
            link: links.item(i),
            dest: links.item(i).getAttribute('dest-id')
        }
        pageLinks[i].link.addEventListener('click', () => {
            gotoPage(pageLinks[i].dest);
        });
    }
}