    document.addEventListener("pointerdown",markInteraction,{once:true});
    document.addEventListener("keydown",markInteraction,{once:true});
    render();
    if(typeof restoreRoomSession==="function")restoreRoomSession();
