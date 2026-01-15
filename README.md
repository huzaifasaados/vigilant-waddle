# Updating the System Prompt

This guide explains how to safely update the `systemPrompt` in the project.  
Please follow these steps carefully to avoid breaking the code.

---

## Steps to Update the System Prompt

### 1. Open the Repository
- Log in to your GitHub account
- Open the project repository

### 2. Open `server.js`
- Go to the main project folder
- Open the file named `server.js`

### 3. Find `systemPrompt`
- Scroll down in `server.js`
- Locate the variable named `systemPrompt`

### 4. Copy the Prompt Safely
- Copy the **entire** `systemPrompt` content
- Paste it into **Notepad** (or any plain text editor)

> **Why Notepad?**  
> Notepad saves plain text only and prevents accidental changes to other code, which could cause issues.

### 5. Edit the Prompt
- Modify the promo or instructions inside Notepad
- Do **not** add extra characters, quotes, or formatting

### 6. Update `server.js`
- Copy the updated prompt from Notepad
- Paste it back into `server.js`, replacing the old `systemPrompt`

### 7. Save and Commit
- Scroll down to the commit section
- Add a commit message (e.g. `Updated systemPrompt`)
- Click **Commit changes**

---

## Important Notes

- ❗ Do **not** change any other code in `server.js`
- ❗ Editing other parts of the file may break the system
- ✅ Only update the `systemPrompt` text

---

## Collaboration Flow (If Applicable)

- After committing, send the update request
- Wait for approval
- Once approved, changes will be merged and applied

---

✅ That’s it!  
Your system prompt is now updated safely and correctly.
