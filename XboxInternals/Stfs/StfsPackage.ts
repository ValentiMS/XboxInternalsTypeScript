﻿/// <reference path='../IO/BaseIO.ts' />
/// <reference path='../IO/FileIO.ts' />
/// <reference path='StfsConstants.ts' />
/// <reference path='StfsDefinitions.ts' />
/// <reference path='XContentHeader.ts' />



module XboxInternals.Stfs {


	export class StfsPackage {


		static INT24_MAX = 8388607;

		public metaData: XContentHeader;
		private fileListing: StfsFileListing;
		private writtenToFile: StfsFileListing;

		private io: IO.BaseIO;
		private ioPassedIn: boolean;

		private packageSex: Sex;
		private blockStep: number[];
		private firstHashTableAddress: number;
		private hashOffset: Uint8Array;
		private topLevel: Level;
		private topTable: HashTable;
		private cached: HashTable;
		private tablesPerLevel: number[];

		private flags: number;

		constructor(io: IO.BaseIO, flags: number) {
			this.io = io;
			this.ioPassedIn = true;
			this.flags = flags;
			this.metaData = null;
			this.Init();
		}

		private Init() {
			// TODO: Write code that allows for writing.
			this.Parse();
		}

		private Parse() {
			this.metaData = new XContentHeader(this.io, (this.flags & StfsPackageFlags.StfsPackagePEC));

			if (this.metaData.fileSystem != FileSystem.FileSystemSTFS && (this.flags & StfsPackageFlags.StfsPackagePEC) == 0)
				throw "STFS: Invalid file system header.";

			this.packageSex = <Sex>((~this.metaData.stfsVolumeDescriptor.blockSeperation[0]) & 1);

			if (this.packageSex == Sex.StfsFemale) {
				this.blockStep = [
					0xAB,
					0x718F
				];
			} else {
				this.blockStep = [
					0xAC,
					0x723A
				];
			}

			// address of the first hash table in the package, comes right afte the header.
			this.firstHashTableAddress = (this.metaData.headerSize + 0x0FFF) & 0xFFFFF000;


			this.tablesPerLevel = Array(3);
			this.tablesPerLevel[0] = Math.floor(this.metaData.stfsVolumeDescriptor.allocatedBlockCount / 0xAA) + ((this.metaData.stfsVolumeDescriptor.allocatedBlockCount % 0xAA != 0) ? 1 : 0);
			this.tablesPerLevel[1] = Math.floor(this.tablesPerLevel[0] / 0xAA) + ((this.tablesPerLevel[0] % 0xAA != 0 && this.metaData.stfsVolumeDescriptor.allocatedBlockCount > 0xAA) ? 1 : 0);
			this.tablesPerLevel[2] = Math.floor(this.tablesPerLevel[1] / 0xAA) + ((this.tablesPerLevel[1] % 0xAA != 0 && this.metaData.stfsVolumeDescriptor.allocatedBlockCount > 0x70E4) ? 1 : 0);

			this.topLevel = this.CalculateTopLevel();

			this.topTable = new HashTable();

			this.topTable.trueBlockNumber = this.ComputeLevelNBackingHashBlockNumber(0, this.topLevel);
			this.topTable.level = this.topLevel;

			var baseAddres = (this.topTable.trueBlockNumber << 0xC) + this.firstHashTableAddress;
			this.topTable.addressInFile = baseAddres + ((this.metaData.stfsVolumeDescriptor.blockSeperation[0] & 2) << 0xB);
			this.io.SetPosition(this.topTable.addressInFile);

			var dataBlocksPerHashTreeLevel = [1, 0xAA, 0x70E4];

			this.topTable.entryCount = Math.floor(this.metaData.stfsVolumeDescriptor.allocatedBlockCount / dataBlocksPerHashTreeLevel[this.topLevel]);
			if (this.metaData.stfsVolumeDescriptor.allocatedBlockCount > 0x70E4 && (this.metaData.stfsVolumeDescriptor.allocatedBlockCount % 0x70E4 != 0))
				this.topTable.entryCount++;
			else if (this.metaData.stfsVolumeDescriptor.allocatedBlockCount > 0xAA && (this.metaData.stfsVolumeDescriptor.allocatedBlockCount % 0xAA != 0))
				this.topTable.entryCount++;

			this.topTable.entries = Array(this.topTable.entryCount);
			for (var i = 0; i < this.topTable.entryCount; i++) {
				this.topTable.entries[i] = {
					blockHash: this.io.ReadBytes(0x14),
					status: this.io.ReadByte(),
					nextBlock: this.io.ReadInt24()
				};
			}

			var fe: StfsFileEntry = new StfsFileEntry();
			fe.pathIndicator = 0xFFFF;
			fe.name = "Root";
			fe.entryIndex = 0xFFFF;

			this.fileListing = new StfsFileListing();
			this.fileListing.folder = fe;

			this.ReadFileListing();
		}

		private PrintFileListing(fullListing: StfsFileListing = null, prefix: string = "") {
			if (fullListing == null)
				fullListing = this.fileListing;

			console.log(prefix, fullListing.folder.name);

			prefix += "    ";
			for (var i = 0; i < fullListing.fileEntries.length; i++)
				console.log(prefix, fullListing.fileEntries[i].name);

			for (var i = 0; i < fullListing.folderEntries.length; i++)
				this.PrintFileListing(fullListing.folderEntries[i], prefix + "    ");
		}

		private PrintFileListingExtended(fullListing: StfsFileListing = null, prefix: string = "") {
			if (fullListing == null)
				fullListing = this.fileListing;

			console.log(prefix, fullListing.folder.name);

			prefix += "    ";
			for (var i = 0; i < fullListing.fileEntries.length; i++)
				console.log(prefix, fullListing.fileEntries[i].name);

			for (var i = 0; i < fullListing.folderEntries.length; i++)
				this.PrintFileListing(fullListing.folderEntries[i], prefix + "    ");
		}

		private ReadFileListing() {
			this.fileListing.fileEntries.length = 0;
			this.fileListing.folderEntries.length = 0;


			var entry: StfsFileEntry = new StfsFileEntry();
			entry.startingBlockNum = this.metaData.stfsVolumeDescriptor.fileTableBlockNum;
			entry.fileSize = (this.metaData.stfsVolumeDescriptor.fileTableBlockCount * 0x1000);

			var block = entry.startingBlockNum;

			var fl: StfsFileListing = new StfsFileListing();
			var currentAddr: number;


			for (var x = 0; x < this.metaData.stfsVolumeDescriptor.fileTableBlockCount; x++) {
				currentAddr = this.BlockToAddress(block);
				this.io.SetPosition(currentAddr);

				for (var i = 0; i < 0x40; i++) {
					var fe: StfsFileEntry = new StfsFileEntry();

					// set the current position
					fe.fileEntryAddress = currentAddr + (i * 0x40);

					// calculate the entry index (in the file listing)
					fe.entryIndex = (x * 0x40) + i;

					// read the name, if the length is 0 then break
					fe.name = this.io.ReadString(0x28);
					var lengthy = fe.name.length;
					// read the name Length
					fe.nameLen = this.io.ReadByte();

					if ((fe.nameLen[0] & 0x3F) == 0) {
						this.io.SetPosition(currentAddr + ((i + 1) * 0x40));
						continue;
					}
					else if (fe.name.length == 0)
						break;

					// check for a mismatch inthe total allocated blocks for the file
					fe.blocksForFile = this.io.ReadInt24(IO.EndianType.LittleEndian);
					this.io.SetPosition(this.io.GetPosition() + 3);

					// read more information
					fe.startingBlockNum = this.io.ReadInt24(IO.EndianType.LittleEndian);
					fe.pathIndicator = this.io.ReadWord();
					fe.fileSize = this.io.ReadDword();
					fe.createdTimeStamp = this.io.ReadDword();
					fe.accessTimeStamp = this.io.ReadDword();

					// get the flags
					fe.flags = new Uint8Array(1);
					fe.flags[0] = fe.nameLen[0] >> 6;

					// bits 6 and 7 are flags, clear them
					//fe.nameLen[0] = fe.nameLen[0] & 0x3F;
					fe.nameLen[0] &= 0x3F;
					fe.nameLen[0] = 0xFF;

					var debugPoint = "";
					fl.fileEntries.push(fe);
				}

				block = this.GetBlockHashEntry(block).nextBlock;
			}

			this.fileListing = this.AddToListing(fl, this.fileListing);
			this.writtenToFile = this.fileListing;
		}

		private AddToListing(fullListing: StfsFileListing, out: StfsFileListing): StfsFileListing {

			for (var i = 0; i < fullListing.fileEntries.length; i++) {
				var isDirectory: boolean = (fullListing.fileEntries[i].flags[0] & 2) == 2;

				if (fullListing.fileEntries[i].pathIndicator == out.folder.entryIndex)
				{
					if (!isDirectory)
						out.fileEntries.push(fullListing.fileEntries[i]);
					else if (fullListing.fileEntries[i].entryIndex != out.folder.entryIndex)
					{
						var fl: StfsFileListing = new StfsFileListing();
						fl.folder = fullListing.fileEntries[i];
						out.folderEntries.push(fl);
					}
				}
			}

			for (var i = 0; i < out.folderEntries.length; i++) {
				out.folderEntries[i] = this.AddToListing(fullListing, out.folderEntries[i]);
			}

			return out;
		}

		private CalculateTopLevel(): Level {
			if (this.metaData.stfsVolumeDescriptor.allocatedBlockCount <= 0xAA)
				return Level.Zero;
			else if (this.metaData.stfsVolumeDescriptor.allocatedBlockCount <= 0x70E4)
				return Level.One;
			else if (this.metaData.stfsVolumeDescriptor.allocatedBlockCount <= 0x4AF768)
				return Level.Two;
			else
				throw "STFS: Invalid number of allocated blocks.";
		}


		private ComputeLevelNBackingHashBlockNumber(blockNum: number, level: Level): number {
			switch (level) {
				case Level.Zero:
					return this.ComputeLevel0BackingHashBlockNumber(blockNum);
				case Level.One:
					return this.ComputeLevel1BackingHashBlockNumber(blockNum);
				case Level.Two:
					return this.ComputeLevel2BackingHashBlockNumber(blockNum);
				default:
					throw "STFS: Invalid level.";
			}
		}

		private ComputeLevel0BackingHashBlockNumber(blockNum: number): number {
			if (blockNum < 0xAA)
				return 0;

			var num = (Math.floor(blockNum / 0xAA)) * this.blockStep[0];
			num += ((Math.floor(blockNum / 0x70E4)) + 1) << <number>this.packageSex;

			if (Math.floor(blockNum / 0x70E4) == 0)
				return num;

			return num + (1 << <number>this.packageSex);
		}

		private ComputeLevel1BackingHashBlockNumber(blockNum: number): number {
			if (blockNum < 0x70E4)
				return this.blockStep[0];
			return (1 << <number>this.packageSex) + (Math.floor(blockNum / 0x70E4)) * this.blockStep[1];
		}

		private ComputeLevel2BackingHashBlockNumber(blockNum: number): number {
			return this.blockStep[2];
		}

		private ComputeBackingDataBlockNumber(blockNum: number): number {
			var toReturn = (Math.floor((blockNum + 0xAA) / 0xAA) << <number>this.packageSex) + blockNum;
			if (blockNum < 0xAA)
				return toReturn;
			else if (blockNum < 0x70E4)
				return toReturn + (Math.floor((blockNum + 0x70E4) / 0x70E4) << <number>this.packageSex);
			else
				return (1 << <number>this.packageSex) + (toReturn + (Math.floor((blockNum + 0x70E4) / 0x70E4) << <number>this.packageSex));
		}


		private BlockToAddress(blockNum: number): number {
			if (blockNum >= StfsPackage.INT24_MAX)
				throw "STFS: block number must be less than 0xFFFFFF.";
			return (this.ComputeBackingDataBlockNumber(blockNum) << 0x0C) + this.firstHashTableAddress;
		}

		public GetHashAddressOfBlock(blockNum: number): number {
			if (blockNum >= this.metaData.stfsVolumeDescriptor.allocatedBlockCount)
				throw "STFS: Reference to illegal block number.";

			var hashAddr = (this.ComputeLevel0BackingHashBlockNumber(blockNum) << 0xC) + this.firstHashTableAddress;
			hashAddr += (blockNum % 0xAA) * 0x18;

			switch (this.topLevel) {
				case 0:
					hashAddr += ((this.metaData.stfsVolumeDescriptor.blockSeperation[0] & 2) << 0xB);
					break;
				case 1:
					hashAddr += ((this.topTable.entries[Math.floor(blockNum / 0xAA)].status[0] & 0x40) << 6);
					break;
				case 2:
					var level1Off = ((this.topTable.entries[Math.floor(blockNum / 0x70E4)].status[0] & 0x40) << 6);
					var pos = ((this.ComputeLevel1BackingHashBlockNumber(blockNum) << 0xC) + this.firstHashTableAddress + level1Off) + ((blockNum % 0xAA) * 0x18);
					this.io.SetPosition(pos + 0x14);
					hashAddr += ((this.io.ReadByte()[0] & 0x40) << 6);
					break;
			}

			return hashAddr;
		}

		private GetBlockHashEntry(blockNum: number): HashEntry {
			if (blockNum >= this.metaData.stfsVolumeDescriptor.allocatedBlockCount)
				throw "STFS: Reference to illegal block number.";

			this.io.SetPosition(this.GetHashAddressOfBlock(blockNum));

			return {
				blockHash: this.io.ReadBytes(0x14),
				status: this.io.ReadByte(),
				nextBlock: this.io.ReadInt24()
			};
		}

		public GetFileEntryFromPath(pathInPackage: string, checkFolders: boolean = false, newEntry: StfsFileEntry = null): StfsFileEntry {
			var entry = this.GetFileEntry(pathInPackage.split('\\'), this.fileListing, newEntry, (newEntry != null), checkFolders);

			if (entry.nameLen[0] == 0)
				throw "STFS: File entry " + pathInPackage + " cannot be found in the package.";

			return entry;
		}


		public GetFileEntry(locationOfFile: string[], start: StfsFileListing, newEntry: StfsFileEntry = null, updateEntry: boolean = false, checkFolders: boolean = false): StfsFileEntry {

			if (locationOfFile.length == 1) {

				for (var i = 0; i < start.fileEntries.length; i++) {
					if (start.fileEntries[i].name == locationOfFile[0]) {

						if (updateEntry)
						{
							start.fileEntries[i] = newEntry;
							this.io.SetPosition(start.fileEntries[i].fileEntryAddress);
							this.WriteFileEntry(start.fileEntries[i]);
						}

						return start.fileEntries[i];
					}
				}

				if (checkFolders) {
					for (var i = 0; i < start.folderEntries.length; i++) {

						if (start.folderEntries[i].folder.name == locationOfFile[0]) {
							if (updateEntry) {
								start.folderEntries[i].folder = newEntry;
								this.io.SetPosition(start.folderEntries[i].folder.fileEntryAddress);
								this.WriteFileEntry(start.folderEntries[i].folder);
							}

							return start.folderEntries[i].folder;
						}
					}
				}
			} else {
				for (var i = 0; i < start.folderEntries.length; i++) {
					if (start.folderEntries[i].folder.name == locationOfFile[0]) {
						var index = locationOfFile.indexOf(locationOfFile[0], 0);
						if (index != undefined)
							locationOfFile.splice(index, 1);

						return this.GetFileEntry(locationOfFile, start.folderEntries[i], newEntry, updateEntry, checkFolders);
					}
				}
			}

			var nullEntry = new StfsFileEntry();
			nullEntry.nameLen = new Uint8Array([0]);
			return nullEntry;
		}


		public WriteFileEntry(entry: StfsFileEntry) {
			entry.nameLen = new Uint8Array([entry.name.length]);

			if (entry.nameLen[0] > 0x28)
				throw "STFS: File entry name length cannot be  greater than 40(0x28) characters.";

			var nameLengthAndFlags = entry.nameLen[0] | (entry.flags[0] << 6);

			var orig = this.io.GetEndian();
			this.io.SetEndian(IO.EndianType.BigEndian);

			this.io.WriteString(entry.name, 0x28, false);
			this.io.WriteByte(new Uint8Array([nameLengthAndFlags]));
			this.io.WriteInt24(entry.blocksForFile, IO.EndianType.LittleEndian);
			this.io.WriteInt24(entry.blocksForFile, IO.EndianType.LittleEndian);
			this.io.WriteInt24(entry.startingBlockNum, IO.EndianType.LittleEndian);
			this.io.WriteWord(entry.pathIndicator);
			this.io.WriteDword(entry.fileSize);
			this.io.WriteDword(entry.createdTimeStamp);
			this.io.WriteDword(entry.accessTimeStamp);

			this.io.SetEndian(orig);
		}

		private ExtractBlock(blockNum: number, length: number = 0x1000): Uint8Array {
			if (blockNum >= this.metaData.stfsVolumeDescriptor.allocatedBlockCount)
				throw "STFS: Reference to illegal block number.";
			if (length > 0x1000)
				throw "STFS: length cannot be greater 0x1000";

			this.io.SetPosition(this.BlockToAddress(blockNum));
			return this.io.ReadBytes(length);
		}

		public ExtractFileFromPath(pathInPackage: string, onProgress: (extractProgress: number) => any = null): IO.FileIO {
			var entry = this.GetFileEntryFromPath(pathInPackage);
			return this.ExtractFile(entry, onProgress);
		}

		public ExtractFile(entry: StfsFileEntry, onProgress: (extractProgress: number) => any = null): IO.FileIO {
			if (entry.nameLen[0] == 0)
				throw "STFS: File '" + entry.name + "' doesn't exist in the package.";

			var fileSize = entry.fileSize;

			var fileIO = new IO.FileIO(new ArrayBuffer(fileSize));
			fileIO.SetFileName(entry.name);
			
			if (fileSize == 0)
			{
				if (onProgress != null)
					onProgress(100);
				return fileIO;
			}


			if ((entry.flags[0] & 1) == 1) {

				var buffer = new ArrayBuffer(fileSize);
				
				var startAddress = this.BlockToAddress(entry.startingBlockNum);
				this.io.SetPosition(startAddress);

				var blockCount = (this.ComputeLevel0BackingHashBlockNumber(entry.startingBlockNum) + this.blockStep[0]) - ((startAddress - this.firstHashTableAddress) >> 0xC);

				if (entry.blocksForFile <= blockCount) {
					fileIO.WriteBytes(this.io.ReadBytes(entry.fileSize));

					if (onProgress != null)
						onProgress(100);

					return fileIO;
				} else {
					fileIO.WriteBytes(this.io.ReadBytes(blockCount << 0xC));

					if (onProgress != null)
						onProgress(Math.round((100 / entry.blocksForFile) * blockCount));

				}

				var tempSize = (entry.fileSize - (blockCount << 0xC));
				while (tempSize >= 0xAA000)
				{
					var currentPos = this.io.GetPosition();
					this.io.SetPosition(currentPos + this.GetHashTableSkipSize(currentPos));

					fileIO.WriteBytes(this.io.ReadBytes(0xAA000));

					tempSize -= 0xAA000;
					blockCount += 0xAA;

					if (onProgress != null)
						onProgress(Math.round((100 / entry.blocksForFile) * blockCount));
				}

				if (tempSize != 0) {
					
					var currentPos = this.io.GetPosition();
					this.io.SetPosition(currentPos + this.GetHashTableSkipSize(currentPos));

					fileIO.WriteBytes(this.io.ReadBytes(tempSize));

					if (onProgress != null)
						onProgress(100);
				}

				return fileIO;
			} else {
				var fullReadCounts = Math.floor(fileSize / 0x1000);
				fileSize -= (fullReadCounts * 0x1000);

				var block = entry.startingBlockNum;

				for (var i = 0; i < fullReadCounts; i++) {
					fileIO.WriteBytes(this.ExtractBlock(block));

					block = this.GetBlockHashEntry(block).nextBlock;

					if (onProgress != null)
						onProgress(Math.round((100 / entry.blocksForFile) * (i + 1)));
				}

				if (fileSize != 0) {
					fileIO.WriteBytes(this.ExtractBlock(block, fileSize));

					if (onProgress != null)
						onProgress(100);
				}

				return fileIO;
			}
		}

		public GetHashTableSkipSize(tableAddress: number): number {
			
			var trueBlockNumber = (tableAddress - this.firstHashTableAddress) >> 0xC;

			if (trueBlockNumber == 0)
				return (0x1000 << this.packageSex);

			if (trueBlockNumber == this.blockStep[1])
				return (0x3000 << this.packageSex);
			else if (trueBlockNumber > this.blockStep[1])
				trueBlockNumber -= (this.blockStep[1] + (1 << this.packageSex));

			if (trueBlockNumber == this.blockStep[0] || trueBlockNumber % this.blockStep[1] == 0)
				return (0x2000 << this.packageSex);

			return (0x1000 << this.packageSex);
		}

		public FileExists(pathInPackage: string): boolean {
			var entry = this.GetFileEntry(pathInPackage.split('\\'), this.fileListing);
			return (entry.nameLen[0] != 0);
		}

		public InjectFile(input: IO.FileIO, pathInPackage: string, onProgress: (progress: number) => any = null) {
			if (this.FileExists(pathInPackage))
				throw "STFS: File already exists in the package.";

			var split: string[] = pathInPackage.split("\\");
			var folder: StfsFileListing;

			var size = split.length;
			var fileName: string;
			if (size > 1) {
				fileName = split[size - 1];
				split = split.slice(size - 1, 1);

				folder = this.FindDirectoryListing(split, this.fileListing);
				if (folder == null)
					throw "STFS: The given folder could not be found.";
			} else {
				fileName = pathInPackage;
				folder = this.fileListing;
			}

			var fileSize = input.buffer.byteLength;

			var entry: StfsFileEntry = new StfsFileEntry();
			entry.name = fileName;

			if (fileName.length >= 0x28)
				throw "STFS: file entry name length cannot be greater than 40(0x28) characters.";

			entry.fileSize = fileSize;
			entry.flags = new Uint8Array([FileEntryFlags.ConsecutiveBlocks]);
			entry.pathIndicator = folder.folder.entryIndex;
			entry.startingBlockNum = StfsPackage.INT24_MAX;
			entry.blocksForFile = ((fileSize + 0xFFF) & 0xFFFFFFF000) >> 0xC;
			entry.createdTimeStamp = Date.now();
			entry.accessTimeStamp = entry.createdTimeStamp;


			var block = 0;
			var prevBlock = StfsPackage.INT24_MAX;
			var counter = 0;
			var data = new Uint8Array(0x1000);
			while (fileSize >= 0x1000) {
				block = this.AllocateBlock();

				if (entry.startingBlockNum == StfsPackage.INT24_MAX)
					entry.startingBlockNum = block;

				if (prevBlock != StfsPackage.INT24_MAX)
					this.SetNextBlock(prevBlock, block);


				prevBlock = block;

				this.io.SetPosition(this.BlockToAddress(block));
				this.io.WriteBytes(input.ReadBytes(0x1000));

				fileSize -= 0x1000;

				if (onProgress)
					onProgress(Math.round((100 / entry.blocksForFile) * ++counter));
			}

			if (fileSize != 0) {
				block = this.AllocateBlock();

				if (entry.startingBlockNum == StfsPackage.INT24_MAX)
					entry.startingBlockNum = block;

				if (prevBlock != StfsPackage.INT24_MAX)
					this.SetNextBlock(prevBlock, block);

				this.io.SetPosition(this.BlockToAddress(block));
				this.io.WriteBytes(input.ReadBytes(fileSize));

				fileSize = 0;

				if (onProgress)
					onProgress(100);

			}

			this.SetNextBlock(block, StfsPackage.INT24_MAX);

			folder.fileEntries.push(entry);
			this.WriteFileListing();

			if (this.topLevel == Level.Zero) {
				this.io.SetPosition(this.topTable.addressInFile);

				this.topTable.entryCount = this.metaData.stfsVolumeDescriptor.allocatedBlockCount;

				for (var i = 0; i < this.topTable.entryCount; i++)
				{
					this.topTable.entries[i].blockHash = this.io.ReadBytes(0x14);
					this.topTable.entries[i].status = this.io.ReadByte();
					this.topTable.entries[i].nextBlock = this.io.ReadInt24();
				}
			}

			return entry;

		}

		public WriteFileListing(usePassed?: boolean, outFis?: StfsFileEntry[], outFos?: StfsFileEntry[]) {
			
			var outFiles: StfsFileEntry[];
			var outFolders: StfsFileEntry[];

			if (!usePassed) {
				var temp = this.GenerateRawFileListing(this.fileListing, [], []);
				outFiles = temp.outFiles;
				outFolders = temp.outFolders;
			}

			outFolders = outFolders.splice(1);

			var folders: { [s: number]: number; } = {};
			folders[0xFFFF] = 0xFFFF;

			var alwaysAllocate = false;
			var firstCheck = true;

			var block = this.metaData.stfsVolumeDescriptor.fileTableBlockNum;
			this.io.SetPosition(this.BlockToAddress(block));

			var outFileSize = outFolders.length;

			for (var i = 0; i < outFileSize; i++)
				folders[outFolders[i].entryIndex] = i;

			for (var i = 0; i < outFolders.length; i++) {
				if (firstCheck)
					firstCheck = true;
				else if ((i + 1) % 0x40 == 0) {
					var nextBlock: number;
					if (alwaysAllocate) {
						nextBlock = this.AllocateBlock();

						this.SetNextBlock(block, nextBlock);
					} else {
						nextBlock = this.GetBlockHashEntry(block).nextBlock;

						if (nextBlock == StfsPackage.INT24_MAX) {
							nextBlock = this.AllocateBlock();
							this.SetNextBlock(block, nextBlock);
							alwaysAllocate = true;
						}
					}

					block = nextBlock;
					this.io.SetPosition(this.BlockToAddress(block));
				}

				outFolders[i].pathIndicator = folders[outFolders[i].pathIndicator];

				this.WriteFileEntry(outFolders[i]);
			}

			var outFoldersAndFilesSize = outFileSize + outFiles.length;
			for (var i = outFileSize; i < outFoldersAndFilesSize; i++) {
				if (firstCheck)
					firstCheck = true;
				else if ((i + 1) % 0x40 == 0) {
					var nextBlock: number;
					if (alwaysAllocate) {
						nextBlock = this.AllocateBlock();

						this.SetNextBlock(block, nextBlock);
					} else {
						nextBlock = this.GetBlockHashEntry(block).nextBlock;

						if (nextBlock == StfsPackage.INT24_MAX) {
							nextBlock = this.AllocateBlock();
							this.SetNextBlock(block, nextBlock);
							alwaysAllocate = true;
						}
					}

					block = nextBlock;
					this.io.SetPosition(this.BlockToAddress(block));
				}

				outFiles[i - outFileSize].pathIndicator = folders[outFiles[i - outFileSize].pathIndicator];
				this.WriteFileEntry(outFiles[i - outFileSize]);
			}

			var remainingEntries = (outFoldersAndFilesSize % 0x40);
			var remainer = 0;
			if (remainingEntries > 0)
				remainer = (0x40 - remainingEntries) * 0x40;
			var nullBytes = new Uint8Array(remainer);
			this.io.WriteBytes(nullBytes);

			this.metaData.stfsVolumeDescriptor.fileTableBlockCount = Math.floor(outFoldersAndFilesSize / 0x40) + 1;
			if (outFoldersAndFilesSize % 0x40 == 0 && outFoldersAndFilesSize != 0)
				this.metaData.stfsVolumeDescriptor.fileTableBlockCount--;
			this.metaData.WriteVolumeDescriptor();

			this.ReadFileListing();
		}

		public GenerateRawFileListing(fl: StfsFileListing, outFiles: StfsFileEntry[], outFolders: StfsFileEntry[]): any {
			var fiEntries = fl.fileEntries.length;
			var foEntries = fl.folderEntries.length;
			for (var i = 0; i < fiEntries; i++) {
				outFiles.push(fl.fileEntries[i]);
			}

			outFolders.push(fl.folder);

			for (var i = 0; i < foEntries; i++) {
				var temp = this.GenerateRawFileListing(fl.folderEntries[i], outFiles, outFolders);
				outFiles = temp.outFiles;
				outFolders = temp.outFolders;
			}
			
			return {
				outFiles: outFiles,
				outFolders: outFolders
			}
		}

		public SetNextBlock(blockNum: number, nextBlockNum: number) {
			if (blockNum >= this.metaData.stfsVolumeDescriptor.allocatedBlockCount)
				throw "STFS: Reference to illegal block number.";

			var hashLoc = this.GetHashAddressOfBlock(blockNum) + 0x15;
			this.io.SetPosition(hashLoc);
			this.io.WriteInt24(nextBlockNum);

			if (this.topLevel == Level.Zero)
				this.topTable.entries[blockNum].nextBlock = nextBlockNum;
		}

		public AllocateBlock(): number {
			this.cached = new HashTable();
			this.cached.addressInFile = 0;
			this.cached.entryCount = 0;
			this.cached.level = <Level> -1;
			this.cached.trueBlockNumber = 0xFFFFFFFF;

			var lengthToWrite = 0x1000;


			this.metaData.stfsVolumeDescriptor.allocatedBlockCount++;

			var recalcTablesPerLevel: number[] = [3];
			recalcTablesPerLevel[0] = Math.floor(this.metaData.stfsVolumeDescriptor.allocatedBlockCount / 0xAA) + ((this.metaData.stfsVolumeDescriptor.allocatedBlockCount % 0xAA != 0) ? 1 : 0);
			recalcTablesPerLevel[1] = Math.floor(recalcTablesPerLevel[0] / 0xAA) + ((recalcTablesPerLevel[0] % 0xAA != 0 && this.metaData.stfsVolumeDescriptor.allocatedBlockCount > 0xAA) ? 1 : 0);
			recalcTablesPerLevel[2] = Math.floor(recalcTablesPerLevel[1] / 0xAA) + ((recalcTablesPerLevel[1] % 0xAA != 0 && this.metaData.stfsVolumeDescriptor.allocatedBlockCount > 0x70E4) ? 1 : 0);

			for (var i = 2; i >= 0; i--) {
				if (recalcTablesPerLevel[i] != this.tablesPerLevel[i]) {
					lengthToWrite += (this.packageSex + 1) * 0x1000;
					this.tablesPerLevel[i] = recalcTablesPerLevel[i];

					if ((i + 1) == this.topLevel) {
						this.topTable.entryCount++;
						this.topTable.entries.push(new HashEntry());
						this.topTable.entries[this.topTable.entryCount - 1].status[0] = 0;
						this.topTable.entries[this.topTable.entryCount - 1].nextBlock = 0;


						this.io.SetPosition(this.topTable.addressInFile + ((this.tablesPerLevel[i] - 1) * 0x18) + 0x15);
						this.io.WriteInt24(StfsPackage.INT24_MAX);
					}
				}
			}
			
			var tempBuffer = this.ArrayBufferExtend(this.io.buffer, lengthToWrite);
			this.io.SetBuffer(tempBuffer);
			this.io.SetPosition(this.io.buffer.byteLength - 1);

			var newTop: Level = this.CalculateTopLevel();
			if (this.topLevel != newTop) {
				this.topLevel = newTop;
				this.topTable.level = this.topLevel;

				var blockOffset = this.metaData.stfsVolumeDescriptor.blockSeperation[0] & 2;
				this.metaData.stfsVolumeDescriptor.blockSeperation[0] &= 0xFD;
				this.topTable.addressInFile = this.GetHashTableAddress(0, this.topLevel);
				this.topTable.entryCount = 2;
				this.topTable.trueBlockNumber = this.ComputeLevelNBackingHashBlockNumber(0, this.topLevel);

				this.topTable.entries = [];

				this.topTable.entries[0].status[0] = blockOffset << 5;
				this.io.SetPosition(this.topTable.addressInFile + 0x14);
				this.io.WriteByte(this.topTable.entries[0].status);

				this.metaData.stfsVolumeDescriptor.blockSeperation[0] &= 0xFD;
			}

			this.io.SetPosition(this.GetHashAddressOfBlock(this.metaData.stfsVolumeDescriptor.allocatedBlockCount - 1) + 0x14);
			this.io.WriteByte(new Uint8Array([0x80]));

			if (this.topLevel == Level.Zero) {
				this.topTable.entryCount++;
				this.topTable.entries.push(new HashEntry());
				this.topTable.entries[this.metaData.stfsVolumeDescriptor.allocatedBlockCount - 1].status[0] = BlockStatusLevelZero.Allocated;
				this.topTable.entries[this.metaData.stfsVolumeDescriptor.allocatedBlockCount - 1].nextBlock = StfsPackage.INT24_MAX;
			}

			this.io.WriteInt24(StfsPackage.INT24_MAX);
			
			this.metaData.WriteVolumeDescriptor();

			
			return this.metaData.stfsVolumeDescriptor.allocatedBlockCount - 1;
		}

		public GetHashTableAddress(index: number, lvl: Level): number {
			var baseAddress = this.GetBaseHashTableAddress(index, lvl);
			
			if (this.packageSex == Sex.StfsFemale)
				return baseAddress;

			else if (lvl = this.topTable.level)
				return baseAddress + ((this.metaData.stfsVolumeDescriptor.blockSeperation[0] & 2) << 0xB);
			else {
				this.io.SetPosition(this.GetTableHashAddress(index, lvl));
			}
		}

		public GetBaseHashTableAddress(index: number, lvl: Level) {
			return ((this.ComputeLevelNBackingHashBlockNumber(index * dataBlocksPerHashTreeLevel[lvl], lvl) << 0xC) + this.firstHashTableAddress);
		}

		public GetTableHashAddress(index: number, lvl: Level): number {
			if (lvl >= this.topTable.level || lvl < Level.Zero)
				throw "STFS: Level is invalid. No parent hash address accessible.";

			var baseHashAddress = this.GetBaseHashTableAddress(Math.floor(index / 0xAA), <Level>(lvl + 1));

			if (lvl + 1 == this.topLevel)
				baseHashAddress += ((this.metaData.stfsVolumeDescriptor.blockSeperation[0] & 2) << 0xB);
			else
				baseHashAddress += ((this.topTable.entries[index].status[0] & 0x40) << 6);

			return baseHashAddress + (index * 0x18);
		}

		public FindDirectoryListing(locationOfDirectory: string[], start: StfsFileListing) {
			
			if (locationOfDirectory.length == 0)
				return start;

			var finalLoop = (locationOfDirectory.length == 1);
			for (var i = 0; i < start.folderEntries.length; i++) {
				if (start.folderEntries[i].folder.name == locationOfDirectory[0]) {
					locationOfDirectory = locationOfDirectory.slice(0, 1);
					if (finalLoop)
						return start.folderEntries[i];
					else
						for (var i = 0; i < start.folderEntries.length; i++)
							return this.FindDirectoryListing(locationOfDirectory, start.folderEntries[i]);
				}
			}
		}

		public ArrayBufferExtend(buf: ArrayBuffer, appendedLength: number): ArrayBuffer {
			var tmp = new Uint8Array(buf.byteLength + appendedLength);
			tmp.set(new Uint8Array(buf), 0);
			return tmp.buffer;
		}

		public ArrayBufferConcat(buf1: ArrayBuffer, buf2: ArrayBuffer): ArrayBuffer {
			var tmp = new Uint8Array(buf1.byteLength + buf2.byteLength);
			tmp.set(new Uint8Array(buf1), 0);
			tmp.set(new Uint8Array(buf2), buf2.byteLength);
			return tmp.buffer;
		}
	}


	export class StfsFileEntry {
		entryIndex: number;
		name: string;
		nameLen: Uint8Array;
		flags: Uint8Array;
		blocksForFile: number;
		startingBlockNum: number;
		pathIndicator: number;
		fileSize: number;
		createdTimeStamp: number;
		accessTimeStamp: number;
		fileEntryAddress: number;
		blockChain: number[];
	}

	export class StfsFileListing {
		fileEntries: StfsFileEntry[];
		folderEntries: StfsFileListing[];
		folder: StfsFileEntry;

		constructor() {
			this.fileEntries = [];
			this.folderEntries = [];
			this.folder = new StfsFileEntry();
		}
	}

	export class HashEntry {
		blockHash: Uint8Array;
		status: Uint8Array;
		nextBlock: number;

		constructor() {
			this.blockHash = new Uint8Array(0x14);
			this.status = new Uint8Array(0x1);
		}
	}

	export class HashTable {
		level: Level;
		trueBlockNumber: number;
		entryCount: number;
		entries: HashEntry[];
		addressInFile: number;
	}

	export enum StfsPackageFlags {
		StfsPackagePEC = 1,
		StfsPackageCreate = 2,
		StfsPackageFemale = 4     // only used when creating a packge
	}
}