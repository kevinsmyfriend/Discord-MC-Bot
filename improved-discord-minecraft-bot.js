// discord-minecraft-bot.js
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');
const { exec, spawn } = require('child_process');
const dotenv = require('dotenv');
const path = require('path');
const fs = require('fs');

// Load environment variables
dotenv.config();

// Configuration - Update these values
const MINECRAFT_SERVER_BAT_PATH = 'D:\\forgeexperiment\\run.bat'; // Change this to your .bat file path
const SERVER_STATUS_FILE = 'server_status.json'; // File to track server status
const ALLOWED_ROLE_NAME = 'Minecraft'; // Role that can use the commands

// Initialize Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages
  ]
});

// Global variable to store the server process
let serverProcess = null;

// Track server state
let serverStatus = {
  running: false,
  startTime: null,
  startedBy: null
};

// Load status if exists
if (fs.existsSync(SERVER_STATUS_FILE)) {
  try {
    serverStatus = JSON.parse(fs.readFileSync(SERVER_STATUS_FILE));
    // Reset running status on bot restart - the process is no longer tracked
    serverStatus.running = false;
    saveServerStatus();
  } catch (err) {
    console.error('Error loading server status:', err);
  }
}

// Save server status to file
function saveServerStatus() {
  fs.writeFileSync(SERVER_STATUS_FILE, JSON.stringify(serverStatus, null, 2));
}

// Check if user has permission to use command
function hasPermission(member) {
  return member.roles.cache.some(role => role.name === ALLOWED_ROLE_NAME);
}

// Register slash commands
async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('start-server')
      .setDescription('Start the Minecraft server'),
    new SlashCommandBuilder()
      .setName('server-status')
      .setDescription('Check if the Minecraft server is running'),
    new SlashCommandBuilder()
      .setName('stop-server')
      .setDescription('Stop the Minecraft server')
  ];

  try {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    console.log('Started refreshing application (/) commands.');

    await rest.put(
      Routes.applicationCommands(process.env.CLIENT_ID),
      { body: commands.map(command => command.toJSON()) }
    );

    console.log('Successfully reloaded application (/) commands.');
  } catch (error) {
    console.error(error);
  }
}

// When bot is ready
client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
  registerCommands();
});

// Handle slash commands
client.on('interactionCreate', async interaction => {
  if (!interaction.isCommand()) return;

  // Check permissions
  if (!hasPermission(interaction.member)) {
    return interaction.reply({ 
      content: `You need the "${ALLOWED_ROLE_NAME}" role to use this command!`, 
      ephemeral: true 
    });
  }

  const { commandName } = interaction;

  if (commandName === 'start-server') {
    if (serverStatus.running) {
      return interaction.reply({
        content: `Server is already running! It was started by ${serverStatus.startedBy} at ${new Date(serverStatus.startTime).toLocaleString()}.`,
        ephemeral: true
      });
    }

    await interaction.reply({ content: 'Starting Minecraft server... Please wait.', ephemeral: true });

    try {
      console.log(`Attempting to execute: ${MINECRAFT_SERVER_BAT_PATH}`);
      
      // Start the server process
      serverProcess = spawn('cmd.exe', ['/c', MINECRAFT_SERVER_BAT_PATH], {
        cwd: path.dirname(MINECRAFT_SERVER_BAT_PATH),  // Set working directory to batch file folder
        detached: false, // Keep process attached for control
        windowsHide: false,
        shell: true,
        stdio: ['pipe', 'pipe', 'pipe'] // Allow stdin, stdout, stderr pipes
      });
      
      console.log('Server process spawned with PID:', serverProcess.pid);
      
      serverProcess.on('error', (err) => {
        console.error(`Failed to start server: ${err}`);
        serverStatus.running = false;
        saveServerStatus();
        interaction.followUp({ content: `Failed to start server: ${err.message}`, ephemeral: true });
      });
      
      serverProcess.stdout.on('data', (data) => {
        console.log(`Server output: ${data}`);
      });
      
      serverProcess.stderr.on('data', (data) => {
        console.error(`Server error: ${data}`);
      });
      
      serverProcess.on('close', (code) => {
        console.log(`Server process exited with code ${code}`);
        serverStatus.running = false;
        saveServerStatus();
      });
      
      // Update server status
      serverStatus.running = true;
      serverStatus.startTime = Date.now();
      serverStatus.startedBy = interaction.user.tag;
      saveServerStatus();
      
      interaction.followUp({ content: 'Server starting! Please be patient, it can take up to a minute or two to go online.', ephemeral: false });
    } catch (err) {
      console.error('Error executing batch file:', err);
      interaction.followUp({ content: `Failed to start the server: ${err.message}`, ephemeral: true });
    }
  }

  else if (commandName === 'server-status') {
    if (serverStatus.running) {
      const runningTime = Math.floor((Date.now() - serverStatus.startTime) / 60000);
      interaction.reply({
        content: `Server is currently running! Started by ${serverStatus.startedBy} ${runningTime} minutes ago.`,
        ephemeral: false
      });
    } else {
      interaction.reply({
        content: 'Server is currently offline. Use /start-server to start it.',
        ephemeral: false
      });
    }
  } 
  
  else if (commandName === 'stop-server') {
    if (!serverStatus.running) {
      return interaction.reply({
        content: `Server is already off! Use /server-start to start the server.`,
        ephemeral: true
      });
    }
    
    await interaction.reply({ content: 'Stopping Minecraft server...', ephemeral: false });
    
    try {
      if (serverProcess && !serverProcess.killed) {
        console.log('Sending stop command to Minecraft server...');
        
        // Send "stop" command to Minecraft server stdin
        if (serverProcess.stdin) {
          serverProcess.stdin.write("stop\r\n");
          
          // Set a timeout to forcibly kill the process if it doesn't respond to the stop command
          setTimeout(() => {
            if (serverStatus.running && serverProcess && !serverProcess.killed) {
              console.log('Server did not stop gracefully, killing process...');
              serverProcess.kill();
            }
          }, 30000); // 30 seconds timeout
          
          interaction.followUp({ 
            content: 'Stop command sent to the server. It should shut down shortly.', 
            ephemeral: false 
          });
        } else {
          // If stdin is not available, try to kill the process
          serverProcess.kill();
          interaction.followUp({ 
            content: 'Forced server shutdown.', 
            ephemeral: false 
          });
        }
      } else {
        // Process reference is invalid, reset status
        interaction.followUp({ 
          content: 'Server process not found. Resetting server status.', 
          ephemeral: false 
        });
      }
      
      // Update status
      serverStatus.running = false;
      saveServerStatus();
      
    } catch (err) {
      console.error('Error stopping server:', err);
      interaction.followUp({ 
        content: `Error stopping server: ${err.message}. Server status has been reset.`, 
        ephemeral: true 
      });
      
      // Reset status on error
      serverStatus.running = false;
      saveServerStatus();
    }
  }
});

// Login the bot
client.login(process.env.DISCORD_TOKEN);
